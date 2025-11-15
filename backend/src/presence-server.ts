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

export interface PresenceLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface PresenceBridgeOptions extends PresenceEventBridgeOptions {}

export interface PresenceInitOptions {
  io: Server;
  redis: Redis;
  ttlMs?: number;
  reaperIntervalMs?: number;
  reaperLookbackMs?: number;
  logger?: PresenceLogger;
  bridge?: PresenceBridgeOptions;
}

export interface PresenceRuntime {
  dispose(): Promise<void>;
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

  try {
    bridge = await service.createSocketBridge(options.io, options.bridge);
    const handlerContext: PresenceHandlerContext = {
      io: options.io,
      redis: options.redis,
      logger,
    };
    registerPresenceHandlers(handlerContext, service);
    service.startReaper();
  } catch (error) {
    await safeStop(service, bridge, logger);
    throw error;
  }

  return {
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await safeStop(service, bridge, logger);
    },
  };
}

async function safeStop(
  service: PresenceService,
  bridge: PresenceEventBridge | null,
  logger: PresenceLogger
): Promise<void> {
  if (bridge) {
    try {
      await bridge.stop();
    } catch (error) {
      logger.error("Failed to stop presence bridge", error);
    }
  }

  try {
    await service.stop();
  } catch (error) {
    logger.error("Failed to stop presence service", error);
  }
}

