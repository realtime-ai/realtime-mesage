import type { Socket } from "socket.io-client";
import { EventEmitter } from "../../core/event-emitter";
import type { Logger } from "../../core/types";
import type { PresenceChannelOptions, PresenceJoinResponse } from "../presence/types";
import { ChannelPresence } from "./channel-presence";
import { ChannelStorage } from "./channel-storage";
import type { ChannelEvents, StorageOptions } from "./types";

/**
 * Channel provides a unified interface for both presence and storage operations
 * on a specific channel. This is the recommended way to interact with channels.
 *
 * @example
 * ```typescript
 * // Define your types
 * interface UserPresenceState {
 *   status: 'active' | 'away';
 *   typing: boolean;
 * }
 *
 * interface RoomStorage {
 *   topic: string;
 *   moderator: string;
 *   config: { theme: string; lang: string };
 * }
 *
 * // Create a channel instance
 * const room = client.channel<UserPresenceState, RoomStorage>('room-1');
 *
 * // Presence operations
 * await room.presence.join('alice', { status: 'active', typing: false });
 * await room.presence.updateState({ typing: true });
 *
 * // Storage operations
 * await room.storage.set('topic', 'Daily Standup');
 * const topic = await room.storage.get('topic');
 *
 * // Or use convenience methods
 * await room.join('alice', { status: 'active', typing: false });
 * await room.set('topic', 'Daily Standup');
 * ```
 */
export class Channel<TPresenceState = unknown, TStorageSchema = Record<string, unknown>> extends EventEmitter<ChannelEvents<TPresenceState>> {
  private readonly socket: Socket;
  private readonly logger: Logger;
  private readonly channelId: string;
  private readonly channelType: string;

  /** Presence sub-module for managing online users and their states */
  readonly presence: ChannelPresence<TPresenceState>;

  /** Storage sub-module for persisting channel data */
  readonly storage: ChannelStorage<TStorageSchema>;

  constructor(
    socket: Socket,
    channelId: string,
    logger: Logger,
    options?: {
      channelType?: string;
      presenceOptions?: PresenceChannelOptions;
      metadataEventName?: string;
    }
  ) {
    super();
    this.socket = socket;
    this.channelId = channelId;
    this.channelType = options?.channelType ?? "ROOM";
    this.logger = logger;

    // Initialize sub-modules
    this.presence = new ChannelPresence<TPresenceState>(
      socket,
      channelId,
      logger,
      options?.presenceOptions
    );

    this.storage = new ChannelStorage<TStorageSchema>(
      socket,
      channelId,
      this.channelType,
      logger,
      options?.metadataEventName
    );

    // Forward events from sub-modules to unified channel events
    this.setupEventForwarding();
  }

  /**
   * Get the channel ID
   */
  getChannelId(): string {
    return this.channelId;
  }

  /**
   * Get the channel type
   */
  getChannelType(): string {
    return this.channelType;
  }

  // ===== Convenience Methods (proxy to sub-modules) =====

  /**
   * Join the channel with presence (convenience method)
   * @see ChannelPresence.join
   */
  async join(userId: string, state?: TPresenceState): Promise<PresenceJoinResponse> {
    return this.presence.join(userId, state);
  }

  /**
   * Leave the presence channel (convenience method)
   * @see ChannelPresence.leave
   */
  async leave(): Promise<void> {
    return this.presence.leave();
  }

  /**
   * Get a storage value by key (convenience method)
   * @see ChannelStorage.get
   */
  async get<K extends keyof TStorageSchema>(key: K): Promise<TStorageSchema[K] | null> {
    return this.storage.get(key);
  }

  /**
   * Set a storage value by key (convenience method)
   * @see ChannelStorage.set
   */
  async set<K extends keyof TStorageSchema>(
    key: K,
    value: TStorageSchema[K],
    options?: StorageOptions
  ): Promise<void> {
    return this.storage.set(key, value, options);
  }

  /**
   * Remove a storage key (convenience method)
   * @see ChannelStorage.remove
   */
  async remove<K extends keyof TStorageSchema>(key: K, options?: StorageOptions): Promise<void> {
    return this.storage.remove(key, options);
  }

  /**
   * Dispose the channel and clean up resources
   */
  dispose(): void {
    this.storage.dispose();
    this.removeAll();
  }

  private setupEventForwarding(): void {
    // Forward presence events
    this.presence.on("joined", (event) => {
      this.emit("presenceJoined", event);
    });

    this.presence.on("left", (event) => {
      this.emit("presenceLeft", event);
    });

    this.presence.on("updated", (event) => {
      this.emit("presenceUpdated", event);
    });

    this.presence.on("error", (error) => {
      this.emit("error", error);
    });

    // Forward storage events
    this.storage.on("updated", (event) => {
      this.emit("storageUpdated", event);
    });

    this.storage.on("removed", (event) => {
      this.emit("storageRemoved", event);
    });

    this.storage.on("error", (error) => {
      this.emit("error", error);
    });
  }
}
