import type { ConnectionStateSnapshot, PresenceEventEnvelope } from "../presence/types";
import type { ChannelMetadataEvent, ChannelMetadataRecord } from "../metadata/types";

/**
 * Storage operation types
 */
export type StorageOperation = "set" | "update" | "remove";

/**
 * Storage item for batch operations
 */
export interface StorageItem {
  key: string;
  value?: string;
  revision?: number;
}

/**
 * Storage options for operations
 */
export interface StorageOptions {
  majorRevision?: number;
  lockName?: string;
  addTimestamp?: boolean;
  addUserId?: boolean;
}

/**
 * Storage entry with metadata
 */
export interface StorageEntry {
  value: string;
  revision: number;
  updated?: string;
  authorUid?: string;
}

/**
 * Storage response from server
 */
export interface StorageResponse {
  timestamp: number;
  channelName: string;
  channelType: string;
  totalCount: number;
  majorRevision: number;
  metadata: Record<string, StorageEntry>;
}

/**
 * Storage event payload
 */
export interface StorageEvent {
  channelName: string;
  channelType: string;
  operation: StorageOperation;
  items: StorageItem[];
  majorRevision: number;
  timestamp: number;
  authorUid?: string;
}

/**
 * Lock options for withLock operations
 */
export interface LockOptions {
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Channel presence event types
 */
export interface ChannelPresenceEvents<TState = unknown> {
  joined: PresenceEventEnvelope & { state?: TState };
  left: PresenceEventEnvelope;
  updated: PresenceEventEnvelope & { state?: TState };
  snapshot: ConnectionStateSnapshot[];
  error: Error;
  [key: string]: unknown; // Index signature for EventEmitter compatibility
}

/**
 * Channel storage event types
 */
export interface ChannelStorageEvents {
  updated: StorageEvent;
  removed: StorageEvent;
  error: Error;
  [key: string]: unknown; // Index signature for EventEmitter compatibility
}

/**
 * Unified channel event types
 */
export interface ChannelEvents<TState = unknown> {
  presenceJoined: PresenceEventEnvelope & { state?: TState };
  presenceLeft: PresenceEventEnvelope;
  presenceUpdated: PresenceEventEnvelope & { state?: TState };
  storageUpdated: StorageEvent;
  storageRemoved: StorageEvent;
  error: Error;
  [key: string]: unknown; // Index signature for EventEmitter compatibility
}

/**
 * Presence member info
 */
export interface PresenceMember<TState = unknown> {
  connId: string;
  userId: string;
  state: TState | null;
  lastSeenMs: number;
  epoch: number;
}
