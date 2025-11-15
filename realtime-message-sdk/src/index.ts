// Core
export { RealtimeClient } from "./core/realtime-client";
export type {
  RealtimeClientConfig,
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

// Metadata
export {
  ChannelMetadataClient,
  MetadataError,
  MetadataConflictError,
  MetadataLockError,
  MetadataValidationError,
} from "./modules/metadata/channel-metadata-client";
export type {
  ChannelMetadataOperation,
  ChannelMetadataItem,
  ChannelMetadataOptions,
  ChannelMetadataEntry,
  ChannelMetadataRecord,
  ChannelMetadataResponse,
  ChannelMetadataEvent,
  ChannelMetadataEventMap,
  ChannelMetadataMutationParams,
  ChannelMetadataRemovalParams,
  ChannelMetadataGetParams,
} from "./modules/metadata/types";
