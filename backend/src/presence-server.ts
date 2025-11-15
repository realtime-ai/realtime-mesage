import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { PresenceService } from "./presence/service";
import type { PresenceServiceOptions } from "./presence/service";
import { registerPresenceHandlers } from "./presence/handlers";
import type { PresenceHandlerContext } from "./presence/handlers";
import type {
  PresenceEventBridge,
  PresenceEventBridgeOptions,
} from "./presence/types";
import { HeartbeatBatcher } from "./presence/heartbeat-batcher";
import { LuaHeartbeatExecutor } from "./presence/lua-heartbeat-executor";
import { TransactionalMetadataWrapper } from "./presence/metadata-transactional";

export interface PresenceLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface PresenceBridgeOptions extends PresenceEventBridgeOptions {}

/**
 * 性能优化选项
 */
export interface PresenceOptimizationOptions {
  /**
   * 启用心跳批处理
   * 将短时间内的多个心跳请求合并为一次 Redis Pipeline 操作
   * @default false
   */
  enableHeartbeatBatching?: boolean;

  /**
   * 批处理窗口时间（毫秒）
   * @default 50
   */
  heartbeatBatchWindowMs?: number;

  /**
   * 最大批次大小
   * @default 100
   */
  heartbeatMaxBatchSize?: number;

  /**
   * 启用 Lua 脚本优化心跳
   * 将心跳操作原子化，减少网络往返次数
   * @default false
   */
  enableLuaHeartbeat?: boolean;

  /**
   * 启用 Metadata 事务性操作（WATCH/MULTI）
   * 使用 Redis 事务保证原子性，避免应用层竞态
   * @default false
   */
  enableTransactionalMetadata?: boolean;

  /**
   * Metadata 事务最大重试次数
   * @default 5
   */
  metadataMaxRetries?: number;
}

export interface PresenceInitOptions {
  io: Server;
  redis: Redis;
  ttlMs?: number;
  reaperIntervalMs?: number;
  reaperLookbackMs?: number;
  logger?: PresenceLogger;
  bridge?: PresenceBridgeOptions;
  /**
   * 性能优化选项
   */
  optimizations?: PresenceOptimizationOptions;
}

export interface PresenceRuntime {
  dispose(): Promise<void>;
  /**
   * 获取心跳批处理器（如果启用）
   */
  getHeartbeatBatcher(): HeartbeatBatcher | null;
  /**
   * 获取 Lua 心跳执行器（如果启用）
   */
  getLuaHeartbeatExecutor(): LuaHeartbeatExecutor | null;
  /**
   * 获取事务性 Metadata 包装器（如果启用）
   */
  getTransactionalMetadata(): TransactionalMetadataWrapper | null;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REAPER_INTERVAL_MS = 3_000;

const defaultLogger: PresenceLogger = {
  debug: () => {
    /* noop */
  },
  info: (message: string, meta?: unknown) => {
    console.log(message, meta ?? "");
  },
  warn: (message: string, meta?: unknown) => {
    console.warn(message, meta ?? "");
  },
  error: (message: string, meta?: unknown) => {
    console.error(message, meta ?? "");
  },
};

export async function initPresence(options: PresenceInitOptions): Promise<PresenceRuntime> {
  const logger = options.logger ?? defaultLogger;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const reaperIntervalMs = options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
  const reaperLookbackMs = options.reaperLookbackMs ?? ttlMs * 2;

  const serviceOptions: PresenceServiceOptions = {
    ttlMs,
    reaperIntervalMs,
    reaperLookbackMs,
    logger,
  };

  const service = new PresenceService(options.redis, serviceOptions);
  let bridge: PresenceEventBridge | null = null;
  let disposed = false;

  // 初始化优化组件
  const opts = options.optimizations ?? {};
  let heartbeatBatcher: HeartbeatBatcher | null = null;
  let luaHeartbeatExecutor: LuaHeartbeatExecutor | null = null;
  let transactionalMetadata: TransactionalMetadataWrapper | null = null;

  if (opts.enableHeartbeatBatching) {
    heartbeatBatcher = new HeartbeatBatcher(options.redis, {
      batchWindowMs: opts.heartbeatBatchWindowMs,
      maxBatchSize: opts.heartbeatMaxBatchSize,
      ttlMs,
      logger,
    });
    logger.info("Heartbeat batching enabled", {
      batchWindowMs: opts.heartbeatBatchWindowMs ?? 50,
      maxBatchSize: opts.heartbeatMaxBatchSize ?? 100,
    });
  }

  if (opts.enableLuaHeartbeat) {
    luaHeartbeatExecutor = new LuaHeartbeatExecutor(options.redis, {
      ttlMs,
      logger,
    });
    await luaHeartbeatExecutor.warmup();
    logger.info("Lua heartbeat optimization enabled");
  }

  if (opts.enableTransactionalMetadata) {
    transactionalMetadata = new TransactionalMetadataWrapper(options.redis, {
      maxRetries: opts.metadataMaxRetries,
      logger,
    });
    logger.info("Transactional metadata enabled", {
      maxRetries: opts.metadataMaxRetries ?? 5,
    });
  }

  try {
    bridge = await service.createSocketBridge(options.io, options.bridge);
    const handlerContext: PresenceHandlerContext = {
      io: options.io,
      redis: options.redis,
      logger,
      heartbeatBatcher,
      luaHeartbeatExecutor,
      transactionalMetadata,
    };
    registerPresenceHandlers(handlerContext, service);
    service.startReaper();
  } catch (error) {
    await safeStop(service, bridge, heartbeatBatcher, logger);
    throw error;
  }

  return {
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await safeStop(service, bridge, heartbeatBatcher, logger);
    },
    getHeartbeatBatcher(): HeartbeatBatcher | null {
      return heartbeatBatcher;
    },
    getLuaHeartbeatExecutor(): LuaHeartbeatExecutor | null {
      return luaHeartbeatExecutor;
    },
    getTransactionalMetadata(): TransactionalMetadataWrapper | null {
      return transactionalMetadata;
    },
  };
}

async function safeStop(
  service: PresenceService,
  bridge: PresenceEventBridge | null,
  heartbeatBatcher: HeartbeatBatcher | null,
  logger: PresenceLogger
): Promise<void> {
  if (bridge) {
    try {
      await bridge.stop();
    } catch (error) {
      logger.error("Failed to stop presence bridge", error);
    }
  }

  if (heartbeatBatcher) {
    try {
      heartbeatBatcher.dispose();
    } catch (error) {
      logger.error("Failed to dispose heartbeat batcher", error);
    }
  }

  try {
    await service.stop();
  } catch (error) {
    logger.error("Failed to stop presence service", error);
  }
}

