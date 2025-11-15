import type { Redis } from "ioredis";
import { channelMetadataKey } from "./keys";
import type {
  ChannelMetadataMutationParams,
  ChannelMetadataRemovalParams,
  ChannelMetadataResponse,
  ChannelMetadataOptions,
  ChannelMetadataItemInput,
  ChannelMetadataEntry,
} from "./types";
import {
  MetadataConflictError,
  MetadataValidationError,
  MetadataLockError,
} from "./service";

interface ChannelMetadataState {
  metadata: ChannelMetadataRecord;
  totalCount: number;
  majorRevision: number;
}

type ChannelMetadataRecord = Record<string, ChannelMetadataEntry>;

export interface TransactionalMetadataOptions {
  /**
   * 最大重试次数（WATCH 冲突时）
   * @default 5
   */
  maxRetries?: number;

  /**
   * 重试延迟（毫秒）
   * @default 10
   */
  retryDelayMs?: number;

  /**
   * 日志器
   */
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

/**
 * 事务性 Metadata 操作包装器
 * 
 * 使用 Redis WATCH/MULTI/EXEC 实现真正的原子性操作，
 * 避免应用层 CAS 检查的 TOCTOU 竞态条件。
 * 
 * @example
 * ```typescript
 * const transactional = new TransactionalMetadataWrapper(redis);
 * 
 * const response = await transactional.updateChannelMetadata({
 *   channelName: 'channel-123',
 *   channelType: 'MESSAGE',
 *   data: [{ key: 'topic', value: 'Updated' }],
 *   options: { majorRevision: 5 }
 * });
 * ```
 */
export class TransactionalMetadataWrapper {
  private readonly redis: Redis;
  private readonly options: Required<Omit<TransactionalMetadataOptions, "logger">> & {
    logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  };

  constructor(redis: Redis, options: TransactionalMetadataOptions = {}) {
    this.redis = redis;
    this.options = {
      maxRetries: options.maxRetries ?? 5,
      retryDelayMs: options.retryDelayMs ?? 10,
      logger: options.logger ?? console,
    };
  }

  /**
   * 事务性设置 Metadata
   */
  async setChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    const key = channelMetadataKey(params.channelType, params.channelName);
    const data = params.data ?? [];

    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);

    return this.retryTransaction(key, async () => {
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

      // 使用 MULTI/EXEC 原子写入
      const result = await this.redis
        .multi()
        .hset(key, {
          items: JSON.stringify(nextRecord),
          totalCount: String(totalCount),
          majorRevision: String(nextMajorRevision),
        })
        .exec();

      if (result === null) {
        throw new MetadataConflictError("Transaction aborted due to concurrent modification");
      }

      return this.buildMetadataResponse(
        params.channelType,
        params.channelName,
        nextRecord,
        totalCount,
        nextMajorRevision,
        timestamp
      );
    });
  }

  /**
   * 事务性更新 Metadata
   */
  async updateChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    if (!params.data || params.data.length === 0) {
      throw new MetadataValidationError("At least one metadata item is required");
    }

    const key = channelMetadataKey(params.channelType, params.channelName);

    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);

    return this.retryTransaction(key, async () => {
      const state = await this.readChannelMetadataState(key);
      if (state.totalCount === 0) {
        throw new MetadataValidationError("Channel metadata does not exist");
      }

      this.ensureMajorRevision(params.options?.majorRevision, state.majorRevision);

      const timestamp = Date.now();
      const nextRecord = cloneMetadataRecord(state.metadata);

      for (const item of params.data!) {
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

      // 使用 MULTI/EXEC 原子写入
      const result = await this.redis
        .multi()
        .hset(key, {
          items: JSON.stringify(nextRecord),
          totalCount: String(totalCount),
          majorRevision: String(nextMajorRevision),
        })
        .exec();

      if (result === null) {
        throw new MetadataConflictError("Transaction aborted due to concurrent modification");
      }

      return this.buildMetadataResponse(
        params.channelType,
        params.channelName,
        nextRecord,
        totalCount,
        nextMajorRevision,
        timestamp
      );
    });
  }

  /**
   * 事务性删除 Metadata
   */
  async removeChannelMetadata(
    params: ChannelMetadataRemovalParams
  ): Promise<ChannelMetadataResponse> {
    const key = channelMetadataKey(params.channelType, params.channelName);

    await this.verifyMetadataLock(params.options?.lockName, params.actorUserId);

    return this.retryTransaction(key, async () => {
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

      keysToRemove.forEach((keyName) => {
        delete nextRecord[keyName];
      });

      if (keysToRemove.length === 0) {
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

      // 使用 MULTI/EXEC 原子写入
      const result = await this.redis
        .multi()
        .hset(key, {
          items: JSON.stringify(nextRecord),
          totalCount: String(totalCount),
          majorRevision: String(nextMajorRevision),
        })
        .exec();

      if (result === null) {
        throw new MetadataConflictError("Transaction aborted due to concurrent modification");
      }

      return this.buildMetadataResponse(
        params.channelType,
        params.channelName,
        nextRecord,
        totalCount,
        nextMajorRevision,
        timestamp
      );
    });
  }

  /**
   * 使用 WATCH 重试事务
   */
  private async retryTransaction<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    let attempt = 0;

    while (attempt < this.options.maxRetries) {
      try {
        // WATCH key 监控并发修改
        await this.redis.watch(key);

        try {
          const result = await operation();
          return result;
        } catch (error) {
          // 操作失败，取消 WATCH
          await this.redis.unwatch();
          throw error;
        }
      } catch (error) {
        // 如果是冲突错误，重试
        if (error instanceof MetadataConflictError) {
          attempt++;
          this.options.logger.debug(`Metadata transaction conflict, retry ${attempt}/${this.options.maxRetries}`);

          if (attempt >= this.options.maxRetries) {
            throw new MetadataConflictError(
              `Failed to complete metadata operation after ${this.options.maxRetries} retries`
            );
          }

          // 短暂延迟后重试
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
          continue;
        }

        // 其他错误直接抛出
        throw error;
      }
    }

    throw new MetadataConflictError("Unexpected retry loop exit");
  }

  // ===== 辅助方法（从 PresenceService 复制） =====

  private async verifyMetadataLock(lockName?: string, actorUserId?: string): Promise<void> {
    if (!lockName) {
      return;
    }
    const owner = await this.redis.get(`prs:lock:${lockName}`);
    if (!owner) {
      throw new MetadataLockError(`Lock "${lockName}" is not held by any user`);
    }
    if (!actorUserId) {
      throw new MetadataLockError(`Lock "${lockName}" requires an authenticated user`);
    }
    if (owner !== actorUserId) {
      throw new MetadataLockError(`Lock "${lockName}" is held by a different user`);
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

  private ensureMajorRevision(expected: number | undefined, actual: number): void {
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
      throw new MetadataConflictError(`Revision mismatch for key "${item.key}"`);
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
}

// ===== 工具函数 =====

function parseChannelMetadataRecord(value?: string): ChannelMetadataRecord {
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
      const revision = Number(entry.revision);
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
  } catch {
    return {};
  }
}

function cloneMetadataRecord(record: ChannelMetadataRecord): ChannelMetadataRecord {
  const next: ChannelMetadataRecord = {};
  Object.entries(record).forEach(([key, entry]) => {
    next[key] = { ...entry };
  });
  return next;
}

function normalizeMetadataValue(value?: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function incrementMetadataMajor(current: number): number {
  if (current <= 0) {
    return 1;
  }
  return current + 1;
}

function getOrderedUniqueKeys(items: ChannelMetadataItemInput[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  items.forEach((item) => {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      order.push(item.key);
    }
  });
  return order;
}

