import type { Redis } from "ioredis";
import {
  activeRoomsKey,
  connKey,
  eventsPattern,
  roomConnUsersKey,
  roomConnectionsKey,
  roomEventsChannel,
  roomLastSeenKey,
  roomMembersKey,
  userConnsKey,
} from "./redis-keys";
import type {
  HeartbeatOptions,
  JoinOptions,
  PresenceEventHandler,
  PresenceEventPayload,
  PresenceSnapshotEntry,
} from "./types";

export interface PresenceServiceOptions {
  ttlMs: number;
  reaperIntervalMs: number;
  reaperLookbackMs: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export class PresenceService {
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private reaperTimer: NodeJS.Timeout | null = null;
  private subscriber: Redis | undefined;
  private subscriberPromise: Promise<void> | null = null;
  private readonly eventHandlers = new Set<PresenceEventHandler>();

  constructor(
    private readonly redis: Redis,
    private readonly options: PresenceServiceOptions
  ) {
    this.logger = options.logger ?? console;
  }

  async join(options: JoinOptions): Promise<PresenceSnapshotEntry[]> {
    const now = Date.now();
    const epoch = now;
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
    pipeline.hset(roomConnUsersKey(options.roomId), options.connId, options.userId);
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
    if (stateChanged && nextStateJson) {
      pipeline.hset(key, "state", nextStateJson);
    }
    await pipeline.exec();

    if (stateChanged) {
      await this.publishEvent({
        type: "update",
        roomId,
        userId: details.user_id,
        connId: options.connId,
        state: nextState ?? {},
        ts: now,
        epoch: Number(details.epoch ?? now),
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
    const pipeline = this.redis.multi();
    pipeline.srem(roomConnectionsKey(roomId), connId);
    pipeline.zrem(roomLastSeenKey(roomId), connId);
    pipeline.del(key);
    pipeline.hdel(roomConnUsersKey(roomId), connId);
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
      epoch: Number(details.epoch ?? Date.now()),
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
    await this.teardownSubscriber();
  }

  private async publishEvent(payload: PresenceEventPayload): Promise<void> {
    const channel = roomEventsChannel(payload.roomId);
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
      await subscriber.psubscribe(eventsPattern);
      subscriber.on("pmessage", (_pattern, _channel, message) => {
        const payload = parsePresenceEvent(message);
        if (!payload?.roomId) {
          return;
        }
        this.dispatchEvent(payload);
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
      await this.subscriber.punsubscribe(eventsPattern);
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

      const userId = await this.redis.hget(roomConnUsersKey(roomId), connId);
      if (!userId) {
        await this.redis.multi()
          .srem(roomConnectionsKey(roomId), connId)
          .zrem(roomLastSeenKey(roomId), connId)
          .exec();
        continue;
      }

      await this.redis
        .multi()
        .srem(roomConnectionsKey(roomId), connId)
        .zrem(roomLastSeenKey(roomId), connId)
        .hdel(roomConnUsersKey(roomId), connId)
        .srem(userConnsKey(userId), connId)
        .exec();

      const remainingForUser = await this.countUserConnsInRoom(roomId, userId);
      if (remainingForUser === 0) {
        await this.redis.srem(roomMembersKey(roomId), userId);
      }

      await this.publishEvent({
        type: "leave",
        roomId,
        userId,
        connId,
        state: null,
        ts: Date.now(),
      });
    }

    const remainingConns = await this.redis.scard(roomConnectionsKey(roomId));
    if (remainingConns === 0) {
      await this.redis.srem(activeRoomsKey(), roomId);
    }
  }

  private async countUserConnsInRoom(roomId: string, userId: string): Promise<number> {
    const allConns = await this.redis.smembers(userConnsKey(userId));
    if (allConns.length === 0) {
      return 0;
    }

    const pipeline = this.redis.pipeline();
    allConns.forEach((connId) => pipeline.hget(connKey(connId), "room_id"));
    const results = await pipeline.exec();
    if (!results) {
      return 0;
    }

    let count = 0;
    results.forEach((result, index) => {
      const value = result[1] as string | null;
      if (value === roomId && allConns[index]) {
        count += 1;
      }
    });

    return count;
  }
}

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

const isPromise = <T>(value: T | Promise<T>): value is Promise<T> => {
  return typeof (value as Promise<T>)?.then === "function";
};
