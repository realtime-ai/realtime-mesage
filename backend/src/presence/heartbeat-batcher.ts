import type { Redis } from "ioredis";
import { connKey, roomLastSeenKey, roomConnMetadataKey, roomEventsChannel } from "./keys";
import type { HeartbeatOptions, PresenceEventPayload } from "./types";
import type { PresenceConnectionMetadata } from "./types";

export interface HeartbeatBatcherOptions {
  /**
   * 批处理窗口时间（毫秒）
   * 在此时间内收集的心跳会被批量处理
   * @default 50
   */
  batchWindowMs?: number;

  /**
   * 最大批次大小
   * 达到此数量立即触发批处理
   * @default 100
   */
  maxBatchSize?: number;

  /**
   * 连接 TTL（毫秒）
   */
  ttlMs: number;

  /**
   * 日志器
   */
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

interface HeartbeatRequest {
  options: HeartbeatOptions;
  resolve: (changed: boolean) => void;
  reject: (error: Error) => void;
}

interface HeartbeatResult {
  connId: string;
  changed: boolean;
  epoch?: number;
  error?: string;
  // 用于发布事件的额外数据
  eventData?: {
    roomId: string;
    userId: string;
    state: Record<string, unknown> | null;
  };
}

/**
 * 心跳批处理器
 * 
 * 将短时间内的多个心跳请求合并为一次 Redis Pipeline 操作，
 * 显著减少网络往返次数（RTT），提升高并发场景下的吞吐量。
 * 
 * @example
 * ```typescript
 * const batcher = new HeartbeatBatcher(redis, { batchWindowMs: 50, ttlMs: 30_000 });
 * 
 * // 多个并发心跳会被自动批处理
 * await Promise.all([
 *   batcher.heartbeat({ connId: 'conn-1', patchState: { typing: true } }),
 *   batcher.heartbeat({ connId: 'conn-2', patchState: { cursor: { x: 100 } } }),
 *   batcher.heartbeat({ connId: 'conn-3' })
 * ]);
 * ```
 */
export class HeartbeatBatcher {
  private readonly redis: Redis;
  private readonly options: Required<Omit<HeartbeatBatcherOptions, "logger">> & {
    logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  };
  private buffer = new Map<string, HeartbeatRequest>();
  private flushTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(redis: Redis, options: HeartbeatBatcherOptions) {
    this.redis = redis;
    this.options = {
      batchWindowMs: options.batchWindowMs ?? 50,
      maxBatchSize: options.maxBatchSize ?? 100,
      ttlMs: options.ttlMs,
      logger: options.logger ?? console,
    };
  }

  /**
   * 将心跳请求加入批处理队列
   */
  async heartbeat(options: HeartbeatOptions): Promise<boolean> {
    if (this.disposed) {
      throw new Error("HeartbeatBatcher has been disposed");
    }

    return new Promise<boolean>((resolve, reject) => {
      // 覆盖同一连接的旧请求（最新的状态优先）
      this.buffer.set(options.connId, { options, resolve, reject });

      // 达到最大批次大小，立即刷新
      if (this.buffer.size >= this.options.maxBatchSize) {
        this.flush();
        return;
      }

      // 启动批处理窗口定时器
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.options.batchWindowMs);
        if (typeof this.flushTimer.unref === "function") {
          this.flushTimer.unref();
        }
      }
    });
  }

  /**
   * 立即执行批处理
   */
  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.size === 0) {
      return;
    }

    const batch = Array.from(this.buffer.entries());
    this.buffer.clear();

    const now = Date.now();
    this.options.logger.debug(`Flushing heartbeat batch: ${batch.length} requests`);

    try {
      const results = await this.processBatch(batch, now);

      // 分发结果到各个 Promise
      results.forEach((result) => {
        const request = batch.find(([connId]) => connId === result.connId)?.[1];
        if (!request) {
          return;
        }

        if (result.error) {
          request.reject(new Error(result.error));
        } else {
          request.resolve(result.changed);
        }
      });
    } catch (error) {
      // 批处理失败，拒绝所有请求
      const errorMessage = error instanceof Error ? error.message : String(error);
      batch.forEach(([_, request]) => {
        request.reject(new Error(`Batch heartbeat failed: ${errorMessage}`));
      });
    }
  }

  /**
   * 批量处理心跳请求
   */
  private async processBatch(
    batch: Array<[string, HeartbeatRequest]>,
    now: number
  ): Promise<HeartbeatResult[]> {
    const connIds = batch.map(([connId]) => connId);

    // 1. 批量读取连接详情
    const pipeline = this.redis.pipeline();
    connIds.forEach((connId) => pipeline.hgetall(connKey(connId)));
    const readResults = await pipeline.exec();

    if (!readResults) {
      throw new Error("Pipeline exec returned null");
    }

    // 2. 准备批量写入
    const writePipeline = this.redis.multi();
    const results: HeartbeatResult[] = [];

    for (let i = 0; i < batch.length; i++) {
      const [connId, request] = batch[i]!;
      const [readErr, details] = readResults[i]!;

      if (readErr || !details || typeof details !== "object") {
        results.push({ connId, changed: false, error: "Connection not found" });
        continue;
      }

      const connDetails = details as Record<string, string>;
      if (!connDetails.room_id || !connDetails.user_id) {
        results.push({ connId, changed: false, error: "Invalid connection data" });
        continue;
      }

      const roomId = connDetails.room_id;
      const currentEpoch = this.parseEpoch(connDetails.epoch);
      const requestedEpoch = request.options.epoch;

      // Epoch fencing 检查
      if (requestedEpoch !== undefined && requestedEpoch < currentEpoch) {
        results.push({ connId, changed: false, error: "Stale epoch" });
        continue;
      }

      let effectiveEpoch = currentEpoch;
      if (requestedEpoch !== undefined && requestedEpoch > currentEpoch) {
        effectiveEpoch = requestedEpoch;
      }

      // 检查状态是否变化
      let stateChanged = false;
      let nextStateJson: string | undefined;

      if (request.options.patchState && Object.keys(request.options.patchState).length > 0) {
        const currentState = this.safeParse(connDetails.state);
        const nextState = { ...(currentState ?? {}), ...request.options.patchState };
        nextStateJson = JSON.stringify(nextState);
        if (nextStateJson !== (connDetails.state ?? "{}")) {
          stateChanged = true;
        }
      }

      // 批量写入操作
      const key = connKey(connId);
      writePipeline.hset(key, "last_seen_ms", now.toString());
      writePipeline.pexpire(key, this.options.ttlMs);
      writePipeline.zadd(roomLastSeenKey(roomId), now, connId);

      if (effectiveEpoch !== currentEpoch) {
        writePipeline.hset(key, "epoch", effectiveEpoch.toString());
        writePipeline.hset(
          roomConnMetadataKey(roomId),
          connId,
          this.stringifyMetadata({ userId: connDetails.user_id, epoch: effectiveEpoch })
        );
      }

      if (stateChanged && nextStateJson) {
        writePipeline.hset(key, "state", nextStateJson);
      }

      // 收集结果，包含事件发布所需数据
      const result: HeartbeatResult = {
        connId,
        changed: stateChanged,
        epoch: effectiveEpoch,
      };

      // 如果状态变化，收集事件数据
      if (stateChanged && nextStateJson) {
        result.eventData = {
          roomId,
          userId: connDetails.user_id,
          state: JSON.parse(nextStateJson),
        };
      }

      results.push(result);
    }

    // 3. 执行批量写入
    await writePipeline.exec();

    // 4. 发布状态变更事件
    await this.publishUpdateEvents(results, now);

    return results;
  }

  /**
   * 发布状态变更事件
   */
  private async publishUpdateEvents(
    results: HeartbeatResult[],
    timestamp: number
  ): Promise<void> {
    const eventsToPublish = results.filter(
      (r) => r.changed && r.eventData && !r.error
    );

    if (eventsToPublish.length === 0) {
      return;
    }

    // 使用 Pipeline 批量发布事件
    const publishPipeline = this.redis.pipeline();

    for (const result of eventsToPublish) {
      if (!result.eventData) continue;

      const event: PresenceEventPayload = {
        type: "update",
        roomId: result.eventData.roomId,
        userId: result.eventData.userId,
        connId: result.connId,
        state: result.eventData.state,
        ts: timestamp,
        epoch: result.epoch,
      };

      const channel = roomEventsChannel(result.eventData.roomId);
      publishPipeline.publish(channel, JSON.stringify(event));
    }

    try {
      await publishPipeline.exec();
    } catch (error) {
      this.options.logger.error("Failed to publish heartbeat update events", error);
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // 拒绝所有待处理的请求
    this.buffer.forEach((request) => {
      request.reject(new Error("HeartbeatBatcher disposed"));
    });
    this.buffer.clear();
  }

  /**
   * 获取当前缓冲区大小（用于监控）
   */
  getBufferSize(): number {
    return this.buffer.size;
  }

  private parseEpoch(value?: string | null): number {
    if (value === undefined || value === null || value === "") {
      return 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private safeParse(value?: string): Record<string, unknown> | null {
    if (!value) {
      return null;
    }
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  private stringifyMetadata(metadata: PresenceConnectionMetadata): string {
    return JSON.stringify(metadata);
  }
}

