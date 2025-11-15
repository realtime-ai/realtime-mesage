// Core
export { RealtimeClient } from "./core/realtime-client";
export type {
  RealtimeClientConfig,
  Logger,
} from "./core/types";

// Unified Channel API (Recommended)
export {
  Channel,
  ChannelPresence,
  ChannelStorage,
  StorageError,
  StorageConflictError,
  StorageLockError,
  StorageValidationError,
} from "./modules/channel";
export type {
  StorageOperation,
  StorageItem,
  StorageOptions,
  StorageEntry,
  StorageResponse,
  StorageEvent,
  LockOptions,
  ChannelPresenceEvents,
  ChannelStorageEvents,
  ChannelEvents,
  PresenceMember,
} from "./modules/channel";

// Presence (Legacy - use Channel.presence instead)
/** @deprecated Use Channel.presence instead */
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

// Metadata (Legacy - use Channel.storage instead)
/** @deprecated Use Channel.storage instead */
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
