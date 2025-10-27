import type { RealtimeModule, ModuleContext } from "../../core/types";
import type { PresenceEventBridge } from "./types";
import { PresenceService } from "./service";
import { registerPresenceHandlers } from "./handlers";

export interface PresenceModuleOptions {
  ttlMs: number;
  reaperIntervalMs: number;
  reaperLookbackMs: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export function createPresenceModule(options: PresenceModuleOptions): RealtimeModule {
  let service: PresenceService | null = null;
  let bridge: PresenceEventBridge | null = null;

  return {
    name: "presence",

    async register(context: ModuleContext): Promise<void> {
      service = new PresenceService(context.redis, {
        ttlMs: options.ttlMs,
        reaperIntervalMs: options.reaperIntervalMs,
        reaperLookbackMs: options.reaperLookbackMs,
        logger: options.logger ?? context.logger,
      });

      bridge = await service.createSocketBridge(context.io);
      service.startReaper();

      registerPresenceHandlers(context, service);
    },

    async onShutdown(): Promise<void> {
      if (bridge) {
        await bridge.stop();
        bridge = null;
      }
      if (service) {
        await service.stop();
        service = null;
      }
    },
  };
}

export { PresenceService } from "./service";
export type {
  PresenceServiceOptions,
} from "./service";
export type {
  PresenceEventPayload,
  PresenceEventType,
  PresenceSnapshotEntry,
  JoinOptions,
  HeartbeatOptions,
  LeaveOptions,
  PresenceEventHandler,
  PresenceConnectionMetadata,
  PresenceSocketAdapter,
  PresenceEventBridgeOptions,
  PresenceSocketRoomEmitter,
  PresenceEventBridge,
} from "./types";
export * as presenceKeys from "./keys";
