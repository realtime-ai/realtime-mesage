import type { Redis } from "ioredis";
import {
  connKey,
  roomMembersKey,
  roomConnectionsKey,
  roomLastSeenKey,
  roomConnMetadataKey,
  userConnsKey,
  activeRoomsKey,
} from "./keys";
import type { JoinOptions } from "./types";
import { JOIN_SCRIPT, scriptSHAs } from "./lua-scripts";

export interface LuaJoinExecutorOptions {
  /**
   * 连接 TTL（毫秒）
   */
  ttlMs: number;

  /**
   * 日志器
   */
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

interface JoinScriptResult {
  ok: 0 | 1;
  epoch?: number;
  error?: string;
}

/**
 * Lua 脚本 Join 执行器
 *
 * 使用 Lua 脚本将 join 操作原子化，解决 read-then-write 竞态条件。
 * 确保多节点并发 join 时 epoch 不会回退。
 *
 * @example
 * ```typescript
 * const executor = new LuaJoinExecutor(redis, { ttlMs: 30_000 });
 *
 * const epoch = await executor.join({
 *   roomId: 'room-1',
 *   userId: 'user-1',
 *   connId: 'conn-1',
 *   state: { status: 'active' }
 * });
 * ```
 */
export class LuaJoinExecutor {
  private readonly redis: Redis;
  private readonly options: Required<Omit<LuaJoinExecutorOptions, "logger">> & {
    logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  };
  private scriptLoaded = false;

  constructor(redis: Redis, options: LuaJoinExecutorOptions) {
    this.redis = redis;
    this.options = {
      ttlMs: options.ttlMs,
      logger: options.logger ?? console,
    };
  }

  /**
   * 执行原子 join 操作
   * @returns epoch 值
   */
  async join(options: JoinOptions): Promise<number> {
    await this.ensureScriptLoaded();

    const now = Date.now();
    const stateJson = JSON.stringify(options.state ?? {});

    const keys = [
      connKey(options.connId),
      roomMembersKey(options.roomId),
      roomConnectionsKey(options.roomId),
      roomLastSeenKey(options.roomId),
      roomConnMetadataKey(options.roomId),
      userConnsKey(options.userId),
      activeRoomsKey(),
    ];

    const args = [
      options.connId,
      options.userId,
      options.roomId,
      stateJson,
      String(now),
      String(this.options.ttlMs),
    ];

    try {
      const sha = scriptSHAs.get("join");
      const resultJson = (await this.redis.evalsha(
        sha!,
        keys.length,
        ...keys,
        ...args
      )) as string;
      const result = JSON.parse(resultJson) as JoinScriptResult;

      if (result.ok === 0) {
        throw new Error(result.error ?? "Join failed");
      }

      return result.epoch ?? now;
    } catch (error) {
      // 如果脚本不存在，重新加载
      if (error instanceof Error && error.message.includes("NOSCRIPT")) {
        this.scriptLoaded = false;
        await this.ensureScriptLoaded();
        return this.join(options);
      }
      throw error;
    }
  }

  /**
   * 确保 Lua 脚本已加载到 Redis
   */
  private async ensureScriptLoaded(): Promise<void> {
    if (this.scriptLoaded) {
      return;
    }

    try {
      const sha = await this.redis.script("LOAD", JOIN_SCRIPT);
      scriptSHAs.set("join", sha);
      this.scriptLoaded = true;
      this.options.logger.debug("Lua join script loaded", { sha });
    } catch (error) {
      this.options.logger.error("Failed to load Lua join script", error);
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
