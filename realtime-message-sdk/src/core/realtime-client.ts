import { io, type Socket } from "socket.io-client";
import type { RealtimeClientConfig, Logger } from "./types";
import { PresenceChannel } from "../modules/presence/presence-channel";
import type {
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceChannelOptions,
} from "../modules/presence/types";
import { ChannelMetadataClient } from "../modules/metadata/channel-metadata-client";
import { Channel } from "../modules/channel/channel";

const defaultLogger: Logger = {
  debug: () => {
    /* noop */
  },
  info: () => {
    /* noop */
  },
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

export class RealtimeClient {
  private socket: Socket | null = null;
  private logger: Logger;
  private presenceChannels = new Set<PresenceChannel>();
  private channels = new Map<string, Channel>();
  private eventsBound = false;
  private _metadata: ChannelMetadataClient | null = null;

  constructor(private readonly config: RealtimeClientConfig) {
    this.logger = config.logger ?? defaultLogger;
  }

  /**
   * Get the unified channel API (recommended)
   * @param channelId - The channel identifier (e.g., 'room-1')
   * @returns A Channel instance with presence and storage sub-modules
   * @example
   * ```typescript
   * const room = client.channel<UserState, RoomStorage>('room-1');
   * await room.presence.join('alice', { status: 'active' });
   * await room.storage.set('topic', 'Meeting');
   * ```
   */
  channel<TPresenceState = unknown, TStorageSchema = Record<string, unknown>>(
    channelId: string,
    options?: {
      channelType?: string;
      presenceOptions?: PresenceChannelOptions;
    }
  ): Channel<TPresenceState, TStorageSchema> {
    if (!this.socket) {
      throw new Error("Cannot create channel before connection. Call connect() first.");
    }

    // Return existing channel if already created
    const existing = this.channels.get(channelId);
    if (existing) {
      return existing as Channel<TPresenceState, TStorageSchema>;
    }

    const channel = new Channel<TPresenceState, TStorageSchema>(
      this.socket,
      channelId,
      this.logger,
      {
        channelType: options?.channelType,
        presenceOptions: {
          ...this.config.presence,
          ...options?.presenceOptions,
        },
      }
    );

    this.channels.set(channelId, channel as Channel<unknown, Record<string, unknown>>);
    return channel;
  }

  /**
   * Access the global metadata client (deprecated)
   * @deprecated Use channel().storage instead for channel-scoped storage operations
   * @example
   * ```typescript
   * // Old way (deprecated)
   * const metadata = client.metadata;
   * await metadata.setChannelMetadata({ channelName: 'room-1', ... });
   *
   * // New way (recommended)
   * const room = client.channel('room-1');
   * await room.storage.set('topic', 'Meeting');
   * ```
   */
  get metadata(): ChannelMetadataClient {
    if (!this._metadata) {
      throw new Error("Cannot access metadata before connection. Call connect() first.");
    }
    return this._metadata;
  }

  async connect(): Promise<void> {
    if (this.socket?.connected) {
      this.logger.warn("Already connected");
      return;
    }

    const authQuery = await this.resolveAuthQuery();

    return new Promise<void>((resolve, reject) => {
      const socket = io(this.config.baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: this.config.reconnection ?? true,
        reconnectionAttempts: this.config.reconnectionAttempts ?? 5,
        reconnectionDelayMax: this.config.reconnectionDelayMax ?? 5_000,
        query: authQuery,
      });

      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        socket.off("error", onError);
      };

      const onConnect = async () => {
        cleanup();
        this.socket = socket;
        this.logger.info("Socket connected", { id: socket.id });

        try {
          this._metadata = new ChannelMetadataClient(socket, this.logger);
          this.setupEventHandlers();
          resolve();
        } catch (error) {
          socket.disconnect();
          reject(error);
        }
      };

      const onError = (error: unknown) => {
        cleanup();
        this.logger.error("Socket connection error", error);
        socket.disconnect();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.once("error", onError);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }

    // Dispose metadata client before disconnecting
    if (this._metadata) {
      try {
        this._metadata.dispose();
      } catch (error) {
        this.logger.error("Failed to dispose metadata client", error);
      }
      this._metadata = null;
    }

    const socket = this.socket;
    this.socket = null;

    if (socket.connected) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.off("disconnect", onDisconnect);
          resolve();
        }, 500);

        const onDisconnect = () => {
          clearTimeout(timeout);
          resolve();
        };

        socket.once("disconnect", onDisconnect);
        socket.disconnect();
      });
      this.logger.info("Socket disconnected");
    } else {
      socket.disconnect();
    }

    this.eventsBound = false;
  }

  async shutdown(): Promise<void> {
    // Dispose all unified channels
    for (const channel of this.channels.values()) {
      try {
        await channel.presence.stop();
        channel.dispose();
      } catch (error) {
        this.logger.error("Failed to stop channel", error);
      }
    }
    this.channels.clear();

    // Stop all legacy presence channels
    for (const channel of this.presenceChannels) {
      try {
        await channel.stop();
      } catch (error) {
        this.logger.error("Failed to stop presence channel", error);
      }
    }
    this.presenceChannels.clear();

    // disconnect() will handle metadata cleanup
    await this.disconnect();
  }

  getSocket(): Socket | null {
    return this.socket;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Create a presence channel with custom options (deprecated)
   * @deprecated Use channel().presence instead for a unified API
   * @example
   * ```typescript
   * // Old way (deprecated)
   * const presenceChannel = client.createPresenceChannel();
   * await presenceChannel.join({ roomId: 'room-1', userId: 'alice' });
   *
   * // New way (recommended)
   * const room = client.channel('room-1');
   * await room.presence.join('alice', { status: 'active' });
   * ```
   */
  createPresenceChannel(options?: PresenceChannelOptions): PresenceChannel {
    if (!this.socket) {
      throw new Error("Cannot create presence channel before connection. Call connect() first.");
    }

    const channelOptions = {
      ...this.config.presence,
      ...options,
    };

    const channel = new PresenceChannel(this.socket, channelOptions);
    this.presenceChannels.add(channel);

    return channel;
  }

  /**
   * Join a room with presence (deprecated convenience method)
   * @deprecated Use channel().join() instead
   * @example
   * ```typescript
   * // Old way (deprecated)
   * const { channel } = await client.joinRoom({ roomId: 'room-1', userId: 'alice' });
   *
   * // New way (recommended)
   * const room = client.channel('room-1');
   * await room.join('alice', { status: 'active' });
   * ```
   */
  async joinRoom(
    params: PresenceJoinParams,
    options?: PresenceChannelOptions
  ): Promise<{ channel: PresenceChannel; response: PresenceJoinResponse }> {
    const channel = this.createPresenceChannel(options);
    const response = await channel.join(params);

    if (!response.ok) {
      // Remove channel if join failed
      this.presenceChannels.delete(channel);
    }

    return { channel, response };
  }

  private setupEventHandlers(): void {
    if (!this.socket || this.eventsBound) {
      return;
    }
    this.eventsBound = true;

    this.socket.on("disconnect", async (reason: string) => {
      this.logger.warn("Socket disconnected", { reason });
      this.eventsBound = false;
    });

    this.socket.on("reconnect", (attempt: number) => {
      this.logger.info("Socket reconnected", { attempt });
    });

    this.socket.on("reconnect_attempt", (attempt: number) => {
      this.logger.debug("Attempting to reconnect", { attempt });
    });
  }

  private async resolveAuthQuery(): Promise<Record<string, string>> {
    if (!this.config.authProvider) {
      return {};
    }

    try {
      const value = await this.config.authProvider();
      if (!value || typeof value !== "object") {
        return {};
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [key, String(val)])
      );
    } catch (error) {
      this.logger.error("Auth provider failed", error);
      return {};
    }
  }
}
