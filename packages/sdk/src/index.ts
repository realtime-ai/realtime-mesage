// Core
export { RealtimeClient } from "./core/realtime-client";
export type {
  RealtimeClientConfig,
  ClientModule,
  ClientModuleContext,
  Logger,
} from "./core/types";

// Presence (built-in to RealtimeClient)
export { PresenceChannel } from "./modules/presence/presence-channel";
export type {
  ConnectionStateSnapshot,
  PresenceEventEnvelope,
  PresenceJoinAck,
  PresenceJoinError,
  PresenceHeartbeatAck,
  PresenceHeartbeatError,
  PresenceJoinResponse,
  PresenceHeartbeatResponse,
  PresenceStatePatch,
  PresenceJoinParams,
  PresenceHeartbeatParams,
  PresenceChannelEventMap,
  PresenceChannelOptions,
} from "./modules/presence/types";
export type { CustomEmitOptions } from "./modules/presence/presence-channel";
