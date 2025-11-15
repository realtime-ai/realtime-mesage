import type { Redis } from "ioredis";
import {
  activeRoomsKey,
  connKey,
  eventsPattern,
  channelMetadataKey,
  channelMetadataEventsChannel,
  metadataEventsPattern,
  lockKey,
  roomConnMetadataKey,
  roomConnectionsKey,
  roomEventsChannel,
  roomLastSeenKey,
  roomMembersKey,
  userConnsKey,
} from "./keys";
import type {
  HeartbeatOptions,
  JoinOptions,
  PresenceEventHandler,
  PresenceEventPayload,
  PresenceConnectionMetadata,
  PresenceSocketAdapter,
  PresenceEventBridgeOptions,
  PresenceEventBridge,
  PresenceSnapshotEntry,
  ChannelMetadataMutationParams,
  ChannelMetadataRemovalParams,
  ChannelMetadataGetParams,
  ChannelMetadataResponse,
  ChannelMetadataOptions,
  ChannelMetadataItemInput,
  ChannelMetadataEventPayload,
  ChannelMetadataEventHandler,
  ChannelMetadataEntry,
} from "./types";

export interface PresenceServiceOptions {
  ttlMs: number;
  reaperIntervalMs: number;
  reaperLookbackMs: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

type MetadataErrorCode = "METADATA_CONFLICT" | "METADATA_LOCK" | "METADATA_INVALID";

export class MetadataError extends Error {
  constructor(message: string, public readonly code?: MetadataErrorCode) {
    super(message);
    this.name = "MetadataError";
  }
}

export class MetadataConflictError extends MetadataError {
  constructor(message: string) {
    super(message, "METADATA_CONFLICT");
    this.name = "MetadataConflictError";
  }
}

export class MetadataLockError extends MetadataError {
  constructor(message: string) {
    super(message, "METADATA_LOCK");
    this.name = "MetadataLockError";
  }
}

export class MetadataValidationError extends MetadataError {
  constructor(message: string) {
    super(message, "METADATA_INVALID");
    this.name = "MetadataValidationError";
  }
}

export class PresenceService {
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private reaperTimer: NodeJS.Timeout | null = null;
  private subscriber: Redis | undefined;
  private subscriberPromise: Promise<void> | null = null;
  private readonly eventHandlers = new Set<PresenceEventHandler>();
  private readonly metadataEventHandlers = new Set<ChannelMetadataEventHandler>();

  constructor(
    private readonly redis: Redis,
    private readonly options: PresenceServiceOptions
  ) {
    this.logger = options.logger ?? console;
  }

  async join(options: JoinOptions): Promise<PresenceSnapshotEntry[]> {
    const now = Date.now();
    const epoch = nextEpoch(
      await this.redis.hget(connKey(options.connId), "epoch"),
      now
    );
    const statePayload = options.state ?? {};
    const stateJson = JSON.stringify(statePayload);

    const pipeline = this.redis.multi();
    pipeline.sadd(roomMembersKey(options.roomId), options.userId);
    pipeline.sadd(roomConnectionsKey(options.roomId), options.connId);
    pipeline.hmset(connKey(options.connId), {
      conn_id: options.connId,
      user_id: options.userId,
      room_id: options.roomId,
      last_seen_ms: now.toString(),
      epoch: epoch.toString(),
      state: stateJson,
    });
    pipeline.pexpire(connKey(options.connId), this.options.ttlMs);
    pipeline.zadd(roomLastSeenKey(options.roomId), now, options.connId);
    pipeline.hset(
      roomConnMetadataKey(options.roomId),
      options.connId,
      stringifyMetadata({ userId: options.userId, epoch })
    );
    pipeline.sadd(userConnsKey(options.userId), options.connId);
    pipeline.sadd(activeRoomsKey(), options.roomId);

    await pipeline.exec();

    await this.publishEvent({
      type: "join",
      roomId: options.roomId,
      userId: options.userId,
      connId: options.connId,
      state: statePayload,
      ts: now,
      epoch,
    });

    return this.fetchRoomSnapshot(options.roomId);
  }

  async heartbeat(options: HeartbeatOptions): Promise<boolean> {
    const key = connKey(options.connId);
    const details = await this.redis.hgetall(key);
    if (!details?.room_id || !details.user_id) {
      return false;
    }

    const now = Date.now();
    const roomId = details.room_id;
    const roomState = safeParse(details.state);
    const currentEpoch = parseEpoch(details.epoch);
    const requestedEpoch = options.epoch;

    if (requestedEpoch !== undefined && requestedEpoch < currentEpoch) {
      return false;
    }

    let effectiveEpoch = currentEpoch;
    if (requestedEpoch !== undefined && requestedEpoch > currentEpoch) {
      effectiveEpoch = requestedEpoch;
      details.epoch = effectiveEpoch.toString();
    }

    let stateChanged = false;
    let nextState = roomState;
    let nextStateJson: string | undefined;

    if (options.patchState && Object.keys(options.patchState).length > 0) {
      nextState = { ...(roomState ?? {}), ...options.patchState };
      nextStateJson = JSON.stringify(nextState);
      if (nextStateJson !== (details.state ?? "{}")) {
        stateChanged = true;
        details.state = nextStateJson;
      }
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, "last_seen_ms", now.toString());
    pipeline.pexpire(key, this.options.ttlMs);
    pipeline.zadd(roomLastSeenKey(roomId), now, options.connId);
    if (effectiveEpoch !== currentEpoch) {
      pipeline.hset(key, "epoch", effectiveEpoch.toString());
    }
    if (stateChanged && nextStateJson) {
      pipeline.hset(key, "state", nextStateJson);
    }
    await pipeline.exec();

    if (effectiveEpoch !== currentEpoch) {
      await this.redis.hset(
        roomConnMetadataKey(roomId),
        options.connId,
        stringifyMetadata({ userId: details.user_id, epoch: effectiveEpoch })
      );
    }

    if (stateChanged) {
      await this.publishEvent({
        type: "update",
        roomId,
        userId: details.user_id,
        connId: options.connId,
        state: nextState ?? {},
        ts: now,
        epoch: effectiveEpoch,
      });
    }

    return stateChanged;
  }

  async leave(connId: string): Promise<{ roomId: string; userId: string } | null> {
    const key = connKey(connId);
    const details = await this.redis.hgetall(key);

    if (!details?.room_id || !details.user_id) {
      return null;
    }

    const roomId = details.room_id;
    const userId = details.user_id;
    const epoch = parseEpoch(details.epoch);
    const pipeline = this.redis.multi();
    pipeline.srem(roomConnectionsKey(roomId), connId);
    pipeline.zrem(roomLastSeenKey(roomId), connId);
    pipeline.del(key);
    pipeline.hdel(roomConnMetadataKey(roomId), connId);
    pipeline.srem(userConnsKey(userId), connId);
    await pipeline.exec();

    const [remainingForUser, roomConnCount] = await Promise.all([
      this.countUserConnsInRoom(roomId, userId),
      this.redis.scard(roomConnectionsKey(roomId)),
    ]);

    if (remainingForUser === 0) {
      await this.redis.srem(roomMembersKey(roomId), userId);
    }

    if (roomConnCount === 0) {
      await this.redis.srem(activeRoomsKey(), roomId);
    }

    await this.publishEvent({
      type: "leave",
      roomId,
      userId,
      connId,
      state: null,
      ts: Date.now(),
      epoch,
    });

    return { roomId, userId };
  }

  async fetchRoomSnapshot(roomId: string): Promise<PresenceSnapshotEntry[]> {
    const connIds = await this.redis.smembers(roomConnectionsKey(roomId));
    if (connIds.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();
    connIds.forEach((connId) => pipeline.hgetall(connKey(connId)));
    const results = await pipeline.exec();
    if (!results) {
      return [];
    }

    const snapshot: PresenceSnapshotEntry[] = [];
    results.forEach((result, index) => {
      const data = result[1] as Record<string, string> | null;
      if (!data || !data.user_id) {
        return;
      }
      snapshot.push({
        connId: connIds[index] ?? data.conn_id ?? "",
        userId: data.user_id,
        state: safeParse(data.state),
        lastSeenMs: Number(data.last_seen_ms ?? 0),
        epoch: Number(data.epoch ?? 0),
      });
    });

    return snapshot.filter((entry) => entry.connId !== "");
  }

  async subscribe(handler: PresenceEventHandler): Promise<() => Promise<void>> {
    this.eventHandlers.add(handler);
    try {
      await this.ensureSubscriber();
    } catch (error) {
      this.eventHandlers.delete(handler);
      throw error;
    }

    return async () => {
      this.eventHandlers.delete(handler);
      if (this.eventHandlers.size === 0) {
        await this.teardownSubscriber();
      }
    };
  }

  async subscribeMetadata(
    handler: ChannelMetadataEventHandler
  ): Promise<() => Promise<void>> {
    this.metadataEventHandlers.add(handler);
    try {
      await this.ensureSubscriber();
    } catch (error) {
      this.metadataEventHandlers.delete(handler);
      throw error;
    }

    return async () => {
      this.metadataEventHandlers.delete(handler);
      if (this.eventHandlers.size === 0 && this.metadataEventHandlers.size === 0) {
        await this.teardownSubscriber();
      }
    };
  }

  async createSocketBridge(
    adapter: PresenceSocketAdapter,
    options?: PresenceEventBridgeOptions
  ): Promise<PresenceEventBridge> {
    const eventName = options?.eventName ?? "presence:event";
    const metadataEventName = options?.metadataEventName ?? "metadata:event";

    const unsubscribePresence = await this.subscribe((event) => {
      adapter.to(event.roomId).emit(eventName, event);
    });

    const unsubscribeMetadata = await this.subscribeMetadata((event) => {
      adapter.to(event.channelName).emit(metadataEventName, event);
    });

    return {
      stop: async () => {
        await unsubscribePresence();
        await unsubscribeMetadata();
      },
    };
  }

  async setChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    const data = params.data ?? [];
    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);
    const key = channelMetadataKey(params.channelType, params.channelName);
    const state = await this.readChannelMetadataState(key);
    this.ensureMajorRevision(params.options?.majorRevision, state.majorRevision);

    const timestamp = Date.now();
    const nextRecord = this.buildRecordForSet(
      data,
      params.options,
      params.actorUserId,
      timestamp
    );
    const totalCount = Object.keys(nextRecord).length;
    const nextMajorRevision = incrementMetadataMajor(state.majorRevision);
    await this.persistChannelMetadata(key, nextRecord, totalCount, nextMajorRevision);

    const response = this.buildMetadataResponse(
      params.channelType,
      params.channelName,
      nextRecord,
      totalCount,
      nextMajorRevision,
      timestamp
    );

    const eventItems = this.buildEventItems(nextRecord, getOrderedUniqueKeys(data));
    await this.publishMetadataEvent({
      channelName: params.channelName,
      channelType: params.channelType,
      operation: "set",
      items: eventItems,
      majorRevision: nextMajorRevision,
      timestamp,
      authorUid: params.actorUserId,
    });

    return response;
  }

  async updateChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    if (!params.data || params.data.length === 0) {
      throw new MetadataValidationError("At least one metadata item is required");
    }

    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);
    const key = channelMetadataKey(params.channelType, params.channelName);
    const state = await this.readChannelMetadataState(key);
    if (state.totalCount === 0) {
      throw new MetadataValidationError("Channel metadata does not exist");
    }

    this.ensureMajorRevision(params.options?.majorRevision, state.majorRevision);
    const timestamp = Date.now();
    const nextRecord = cloneMetadataRecord(state.metadata);

    for (const item of params.data) {
      const existing = nextRecord[item.key];
      if (!existing) {
        throw new MetadataValidationError(`Metadata item "${item.key}" does not exist`);
      }
      this.ensureItemRevision(item, existing);
      nextRecord[item.key] = this.buildEntryForUpdate(
        existing,
        item,
        params.options,
        params.actorUserId,
        timestamp
      );
    }

    const totalCount = Object.keys(nextRecord).length;
    const nextMajorRevision = incrementMetadataMajor(state.majorRevision);
    await this.persistChannelMetadata(key, nextRecord, totalCount, nextMajorRevision);

    const response = this.buildMetadataResponse(
      params.channelType,
      params.channelName,
      nextRecord,
      totalCount,
      nextMajorRevision,
      timestamp
    );

    const eventKeys = getOrderedUniqueKeys(params.data);
    const eventItems = this.buildEventItems(nextRecord, eventKeys);
    await this.publishMetadataEvent({
      channelName: params.channelName,
      channelType: params.channelType,
      operation: "update",
      items: eventItems,
      majorRevision: nextMajorRevision,
      timestamp,
      authorUid: params.actorUserId,
    });

    return response;
  }

  async removeChannelMetadata(
    params: ChannelMetadataRemovalParams
  ): Promise<ChannelMetadataResponse> {
    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);
    const key = channelMetadataKey(params.channelType, params.channelName);
    const state = await this.readChannelMetadataState(key);
    this.ensureMajorRevision(params.options?.majorRevision, state.majorRevision);

    if (state.totalCount === 0) {
      const timestamp = Date.now();
      return this.buildMetadataResponse(
        params.channelType,
        params.channelName,
        state.metadata,
        state.totalCount,
        state.majorRevision,
        timestamp
      );
    }

    const nextRecord = cloneMetadataRecord(state.metadata);
    const keysToRemove =
      params.data && params.data.length > 0
        ? getOrderedUniqueKeys(params.data)
        : Object.keys(nextRecord);

    const removedEntries: RemovedMetadataEntry[] = [];
    keysToRemove.forEach((keyName) => {
      const existing = nextRecord[keyName];
      if (existing) {
        removedEntries.push({ key: keyName, entry: existing });
        delete nextRecord[keyName];
      }
    });

    if (removedEntries.length === 0) {
      const timestamp = Date.now();
      return this.buildMetadataResponse(
        params.channelType,
        params.channelName,
        nextRecord,
        state.totalCount,
        state.majorRevision,
        timestamp
      );
    }

    const timestamp = Date.now();
    const totalCount = Object.keys(nextRecord).length;
    const nextMajorRevision = incrementMetadataMajor(state.majorRevision);
    await this.persistChannelMetadata(key, nextRecord, totalCount, nextMajorRevision);

    await this.publishMetadataEvent({
      channelName: params.channelName,
      channelType: params.channelType,
      operation: "remove",
      items: removedEntries.map(({ key: removedKey, entry }) => ({
        key: removedKey,
        value: entry.value,
        revision: entry.revision,
      })),
      majorRevision: nextMajorRevision,
      timestamp,
      authorUid: params.actorUserId,
    });

    return this.buildMetadataResponse(
      params.channelType,
      params.channelName,
      nextRecord,
      totalCount,
      nextMajorRevision,
      timestamp
    );
  }

  async getChannelMetadata(
    params: ChannelMetadataGetParams
  ): Promise<ChannelMetadataResponse> {
    const key = channelMetadataKey(params.channelType, params.channelName);
    const state = await this.readChannelMetadataState(key);
    const timestamp = Date.now();
    return this.buildMetadataResponse(
      params.channelType,
      params.channelName,
      state.metadata,
      state.totalCount,
      state.majorRevision,
      timestamp
    );
  }

  private async verifyMetadataLock(lockName?: string, actorUserId?: string): Promise<void> {
    if (!lockName) {
      return;
    }
    const owner = await this.redis.get(lockKey(lockName));
    if (!owner) {
      throw new MetadataLockError(`Lock "${lockName}" is not held by any user`);
    }
    if (!actorUserId) {
      throw new MetadataLockError(`Lock "${lockName}" requires an authenticated user`);
    }
    if (owner !== actorUserId) {
      throw new MetadataLockError(
        `Lock "${lockName}" is held by a different user`
      );
    }
  }

  private async readChannelMetadataState(key: string): Promise<ChannelMetadataState> {
    const hash = await this.redis.hgetall(key);
    if (!hash || Object.keys(hash).length === 0) {
      return { metadata: {}, totalCount: 0, majorRevision: 0 };
    }
    const metadata = parseChannelMetadataRecord(hash.items);
    const parsedTotal = Number(hash.totalCount);
    const parsedMajor = Number(hash.majorRevision);
    const totalCount = Number.isFinite(parsedTotal)
      ? parsedTotal
      : Object.keys(metadata).length;
    const majorRevision = Number.isFinite(parsedMajor) ? parsedMajor : 0;
    return { metadata, totalCount, majorRevision };
  }

  private async persistChannelMetadata(
    key: string,
    metadata: ChannelMetadataRecord,
    totalCount: number,
    majorRevision: number
  ): Promise<void> {
    await this.redis.hset(key, {
      items: JSON.stringify(metadata),
      totalCount: String(totalCount),
      majorRevision: String(majorRevision),
    });
  }

  private buildMetadataResponse(
    channelType: string,
    channelName: string,
    metadata: ChannelMetadataRecord,
    totalCount: number,
    majorRevision: number,
    timestamp: number
  ): ChannelMetadataResponse {
    return {
      timestamp,
      channelName,
      channelType,
      totalCount,
      majorRevision,
      metadata: cloneMetadataRecord(metadata),
    };
  }

  private ensureMajorRevision(
    expected: number | undefined,
    actual: number
  ): void {
    if (expected === undefined || expected < 0) {
      return;
    }
    if (expected !== actual) {
      throw new MetadataConflictError(
        `Expected major revision ${expected}, but got ${actual}`
      );
    }
  }

  private ensureItemRevision(
    item: ChannelMetadataItemInput,
    current: ChannelMetadataEntry
  ): void {
    if (item.revision === undefined || item.revision < 0) {
      return;
    }
    if (current.revision !== item.revision) {
      throw new MetadataConflictError(
        `Revision mismatch for key "${item.key}"`
      );
    }
  }

  private buildRecordForSet(
    data: ChannelMetadataItemInput[],
    options: ChannelMetadataOptions | undefined,
    actorUserId: string | undefined,
    timestamp: number
  ): ChannelMetadataRecord {
    const record: ChannelMetadataRecord = {};
    data.forEach((item) => {
      const revision = item.revision && item.revision > 0 ? item.revision : 1;
      const entry: ChannelMetadataEntry = {
        value: normalizeMetadataValue(item.value),
        revision,
      };
      if (options?.addTimestamp) {
        entry.updated = new Date(timestamp).toISOString();
      }
      if (options?.addUserId && actorUserId) {
        entry.authorUid = actorUserId;
      }
      record[item.key] = entry;
    });
    return record;
  }

  private buildEntryForUpdate(
    existing: ChannelMetadataEntry,
    payload: ChannelMetadataItemInput,
    options: ChannelMetadataOptions | undefined,
    actorUserId: string | undefined,
    timestamp: number
  ): ChannelMetadataEntry {
    const nextValue =
      payload.value !== undefined
        ? normalizeMetadataValue(payload.value)
        : existing.value;
    const entry: ChannelMetadataEntry = {
      value: nextValue,
      revision: existing.revision + 1,
    };
    if (options?.addTimestamp) {
      entry.updated = new Date(timestamp).toISOString();
    } else if (existing.updated) {
      entry.updated = existing.updated;
    }
    if (options?.addUserId && actorUserId) {
      entry.authorUid = actorUserId;
    } else if (existing.authorUid) {
      entry.authorUid = existing.authorUid;
    }
    return entry;
  }

  private buildEventItems(
    record: ChannelMetadataRecord,
    keys: string[]
  ): ChannelMetadataItemInput[] {
    return keys
      .map((key) => {
        const entry = record[key];
        if (!entry) {
          return null;
        }
        return {
          key,
          value: entry.value,
          revision: entry.revision,
        };
      })
      .filter((item): item is ChannelMetadataItemInput => item !== null);
  }

  startReaper(): void {
    if (this.reaperTimer) {
      return;
    }

    this.reaperTimer = setInterval(() => {
      this.reapOnce().catch((error) => {
        this.logger.error("Presence reaper failed", error);
      });
    }, this.options.reaperIntervalMs);
    if (typeof this.reaperTimer.unref === "function") {
      this.reaperTimer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    this.eventHandlers.clear();
    this.metadataEventHandlers.clear();
    await this.teardownSubscriber();
  }

  private async publishEvent(payload: PresenceEventPayload): Promise<void> {
    const channel = roomEventsChannel(payload.roomId);
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  private async publishMetadataEvent(
    payload: ChannelMetadataEventPayload
  ): Promise<void> {
    const channel = channelMetadataEventsChannel(payload.channelType, payload.channelName);
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  private async ensureSubscriber(): Promise<void> {
    if (this.subscriber) {
      return;
    }

    if (this.subscriberPromise) {
      await this.subscriberPromise;
      return;
    }

    this.subscriberPromise = (async () => {
      const subscriber = this.redis.duplicate();
      await subscriber.psubscribe(eventsPattern, metadataEventsPattern);
      subscriber.on("pmessage", (pattern, _channel, message) => {
        if (pattern === eventsPattern) {
          const payload = parsePresenceEvent(message);
          if (!payload?.roomId) {
            return;
          }
          this.dispatchEvent(payload);
          return;
        }

        if (pattern === metadataEventsPattern) {
          const payload = parseMetadataEvent(message);
          if (!payload?.channelName || !payload.channelType || !payload.operation) {
            return;
          }
          this.dispatchMetadataEvent(payload);
        }
      });
      this.subscriber = subscriber;
    })();

    try {
      await this.subscriberPromise;
    } catch (error) {
      this.logger.error("Failed to create presence subscriber", error);
      throw error;
    } finally {
      this.subscriberPromise = null;
    }
  }

  private async teardownSubscriber(): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    try {
      await this.subscriber.punsubscribe(eventsPattern, metadataEventsPattern);
    } catch (error) {
      this.logger.error("Failed to stop presence subscriber", error);
    }

    this.subscriber.disconnect();
    this.subscriber = undefined;
  }

  private dispatchEvent(payload: PresenceEventPayload): void {
    if (this.eventHandlers.size === 0) {
      return;
    }

    for (const handler of this.eventHandlers) {
      try {
        const result = handler(payload);
        if (isPromise(result)) {
          result.catch((error) => {
            this.logger.error("Presence event handler rejected", error);
          });
        }
      } catch (error) {
        this.logger.error("Presence event handler threw", error);
      }
    }
  }

  private dispatchMetadataEvent(payload: ChannelMetadataEventPayload): void {
    if (this.metadataEventHandlers.size === 0) {
      return;
    }

    for (const handler of this.metadataEventHandlers) {
      try {
        const result = handler(payload);
        if (isPromise(result)) {
          result.catch((error) => {
            this.logger.error("Metadata event handler rejected", error);
          });
        }
      } catch (error) {
        this.logger.error("Metadata event handler threw", error);
      }
    }
  }

  private async reapOnce(): Promise<void> {
    const rooms = await this.redis.smembers(activeRoomsKey());
    if (rooms.length === 0) {
      return;
    }

    const now = Date.now();
    await Promise.all(rooms.map((roomId) => this.reapRoom(roomId, now)));
  }

  private async reapRoom(roomId: string, now: number): Promise<void> {
    const cutoff = now - this.options.reaperLookbackMs;
    if (cutoff <= 0) {
      return;
    }

    const staleConnIds = await this.redis.zrangebyscore(
      roomLastSeenKey(roomId),
      0,
      cutoff
    );

    if (staleConnIds.length === 0) {
      return;
    }

    for (const connId of staleConnIds) {
      const key = connKey(connId);
      const exists = await this.redis.exists(key);
      if (exists) {
        continue;
      }

      const metadataValue = await this.redis.hget(roomConnMetadataKey(roomId), connId);
      const metadata = parseMetadata(metadataValue);
      if (!metadata) {
        await this.redis
          .multi()
          .srem(roomConnectionsKey(roomId), connId)
          .zrem(roomLastSeenKey(roomId), connId)
          .hdel(roomConnMetadataKey(roomId), connId)
          .exec();
        continue;
      }

      await this.redis
        .multi()
        .srem(roomConnectionsKey(roomId), connId)
        .zrem(roomLastSeenKey(roomId), connId)
        .hdel(roomConnMetadataKey(roomId), connId)
        .srem(userConnsKey(metadata.userId), connId)
        .exec();

      const remainingForUser = await this.countUserConnsInRoom(roomId, metadata.userId);
      if (remainingForUser === 0) {
        await this.redis.srem(roomMembersKey(roomId), metadata.userId);
      }

      await this.publishEvent({
        type: "leave",
        roomId,
        userId: metadata.userId,
        connId,
        state: null,
        ts: Date.now(),
        epoch: metadata.epoch,
      });
    }

    const remainingConns = await this.redis.scard(roomConnectionsKey(roomId));
    if (remainingConns === 0) {
      await this.redis.srem(activeRoomsKey(), roomId);
    }
  }

  private async countUserConnsInRoom(roomId: string, userId: string): Promise<number> {
    const metadataValues = await this.redis.hvals(roomConnMetadataKey(roomId));
    if (!metadataValues || metadataValues.length === 0) {
      return 0;
    }

    let count = 0;
    metadataValues.forEach((value) => {
      const metadata = parseMetadata(value);
      if (metadata?.userId === userId) {
        count += 1;
      }
    });

    return count;
  }
}

const parseEpoch = (value?: string | null): number => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const nextEpoch = (previous: string | null, fallback: number): number => {
  const prevEpoch = parseEpoch(previous);
  if (prevEpoch <= 0) {
    return fallback;
  }
  return Math.max(prevEpoch + 1, fallback);
};

const stringifyMetadata = (metadata: PresenceConnectionMetadata): string => {
  return JSON.stringify(metadata);
};

const parseMetadata = (value?: string | null): PresenceConnectionMetadata | null => {
  if (!value) {
    return null;
  }
  try {
    const payload = JSON.parse(value) as Partial<PresenceConnectionMetadata>;
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (!payload.userId || typeof payload.userId !== "string") {
      return null;
    }
    const epoch =
      typeof payload.epoch === "number" && Number.isFinite(payload.epoch)
        ? payload.epoch
        : parseEpoch(payload.epoch !== undefined ? String(payload.epoch) : undefined);
    return { userId: payload.userId, epoch };
  } catch (_error) {
    return null;
  }
};

const safeParse = (value?: string): Record<string, unknown> | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const parsePresenceEvent = (message: string): PresenceEventPayload | null => {
  try {
    const payload = JSON.parse(message) as PresenceEventPayload;
    if (!payload?.roomId || !payload.type) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
};

const parseMetadataEvent = (message: string): ChannelMetadataEventPayload | null => {
  try {
    const payload = JSON.parse(message) as ChannelMetadataEventPayload;
    if (!payload?.channelName || !payload.channelType || !payload.operation) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
};

const isPromise = <T>(value: T | Promise<T>): value is Promise<T> => {
  return typeof (value as Promise<T>)?.then === "function";
};

interface ChannelMetadataState {
  metadata: ChannelMetadataRecord;
  totalCount: number;
  majorRevision: number;
}

interface RemovedMetadataEntry {
  key: string;
  entry: ChannelMetadataEntry;
}

const parseChannelMetadataRecord = (value?: string): ChannelMetadataRecord => {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<ChannelMetadataEntry>>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const result: ChannelMetadataRecord = {};
    Object.entries(parsed).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const revision = Number((entry as ChannelMetadataEntry).revision);
      const normalizedValue =
        entry.value !== undefined && entry.value !== null ? String(entry.value) : "";
      const normalized: ChannelMetadataEntry = {
        value: normalizedValue,
        revision: Number.isFinite(revision) ? revision : 0,
      };
      if (typeof entry.updated === "string") {
        normalized.updated = entry.updated;
      }
      if (typeof entry.authorUid === "string") {
        normalized.authorUid = entry.authorUid;
      }
      result[key] = normalized;
    });
    return result;
  } catch (_error) {
    return {};
  }
};

const cloneMetadataRecord = (record: ChannelMetadataRecord): ChannelMetadataRecord => {
  const next: ChannelMetadataRecord = {};
  Object.entries(record).forEach(([key, entry]) => {
    next[key] = { ...entry };
  });
  return next;
};

const normalizeMetadataValue = (value?: string): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
};

const incrementMetadataMajor = (current: number): number => {
  if (current <= 0) {
    return 1;
  }
  return current + 1;
};

const getOrderedUniqueKeys = (items: ChannelMetadataItemInput[]): string[] => {
  const seen = new Set<string>();
  const order: string[] = [];
  items.forEach((item) => {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      order.push(item.key);
    }
  });
  return order;
};
