import type { Redis } from "ioredis";
import { connKey, roomLastSeenKey, roomConnMetadataKey } from "./keys";
import type { HeartbeatOptions } from "./types";
import { HEARTBEAT_SCRIPT, scriptSHAs } from "./lua-scripts";

export interface LuaHeartbeatExecutorOptions {
  /**
   * 连接 TTL（毫秒）
   */
  ttlMs: number;

  /**
   * 日志器
   */
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

interface HeartbeatScriptResult {
  ok: 0 | 1;
  changed?: 0 | 1;
  epoch?: number;
  error?: string;
}

/**
 * Lua 脚本心跳执行器
 * 
 * 使用 Lua 脚本将心跳操作原子化，从多次 Redis 往返减少到 1 次。
 * 
 * @example
 * ```typescript
 * const executor = new LuaHeartbeatExecutor(redis, { ttlMs: 30_000 });
 * 
 * const changed = await executor.heartbeat({
 *   connId: 'conn-1',
 *   patchState: { typing: true },
 *   epoch: 12345
 * });
 * ```
 */
export class LuaHeartbeatExecutor {
  private readonly redis: Redis;
  private readonly options: Required<Omit<LuaHeartbeatExecutorOptions, "logger">> & {
    logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  };
  private scriptLoaded = false;

  constructor(redis: Redis, options: LuaHeartbeatExecutorOptions) {
    this.redis = redis;
    this.options = {
      ttlMs: options.ttlMs,
      logger: options.logger ?? console,
    };
  }

  /**
   * 执行心跳操作（使用 Lua 脚本）
   */
  async heartbeat(options: HeartbeatOptions): Promise<boolean> {
    await this.ensureScriptLoaded();

    const now = Date.now();
    const patchStateJson =
      options.patchState && Object.keys(options.patchState).length > 0
        ? JSON.stringify(options.patchState)
        : "";
    const requestedEpoch = options.epoch !== undefined ? String(options.epoch) : "";

    // 需要先获取 roomId 来构建完整的 KEYS
    // 这里需要一次额外的 HGET，但总体仍然比原方案少
    const roomId = await this.redis.hget(connKey(options.connId), "room_id");
    if (!roomId) {
      throw new Error("Connection not found");
    }

    const keys = [
      connKey(options.connId),
      roomLastSeenKey(roomId),
      roomConnMetadataKey(roomId),
    ];

    const args = [
      options.connId,
      String(now),
      String(this.options.ttlMs),
      patchStateJson,
      requestedEpoch,
    ];

    try {
      const sha = scriptSHAs.get("heartbeat");
      const resultJson = (await this.redis.evalsha(sha!, keys.length, ...keys, ...args)) as string;
      const result = JSON.parse(resultJson) as HeartbeatScriptResult;

      if (result.ok === 0) {
        throw new Error(result.error ?? "Heartbeat failed");
      }

      return result.changed === 1;
    } catch (error) {
      // 如果脚本不存在，重新加载
      if (error instanceof Error && error.message.includes("NOSCRIPT")) {
        this.scriptLoaded = false;
        await this.ensureScriptLoaded();
        return this.heartbeat(options);
      }
      throw error;
    }
  }

  /**
   * 获取最新 epoch（用于心跳确认）
   */
  async getEpoch(connId: string): Promise<number | undefined> {
    const epochStr = await this.redis.hget(connKey(connId), "epoch");
    if (!epochStr) {
      return undefined;
    }
    const epoch = Number(epochStr);
    return Number.isFinite(epoch) ? epoch : undefined;
  }

  /**
   * 确保 Lua 脚本已加载到 Redis
   */
  private async ensureScriptLoaded(): Promise<void> {
    if (this.scriptLoaded) {
      return;
    }

    try {
      const sha = await this.redis.script("LOAD", HEARTBEAT_SCRIPT);
      scriptSHAs.set("heartbeat", sha);
      this.scriptLoaded = true;
      this.options.logger.debug("Lua heartbeat script loaded", { sha });
    } catch (error) {
      this.options.logger.error("Failed to load Lua heartbeat script", error);
      throw error;
    }
  }

  /**
   * 预热脚本（可选，在服务启动时调用）
   */
  async warmup(): Promise<void> {
    await this.ensureScriptLoaded();
  }
}

