import { io, type Socket } from "socket.io-client";
import type {
  ClientModule,
  ClientModuleContext,
  RealtimeClientConfig,
  Logger,
} from "./types";
import { PresenceChannel } from "../modules/presence/presence-channel";
import type {
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceChannelOptions,
} from "../modules/presence/types";

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
  private modules: ClientModule[] = [];
  private logger: Logger;
  private presenceChannels = new Set<PresenceChannel>();

  constructor(private readonly config: RealtimeClientConfig) {
    this.logger = config.logger ?? defaultLogger;
  }

  use(module: ClientModule): void {
    if (this.socket) {
      throw new Error(
        `Cannot register module "${module.name}" after connection is established`
      );
    }
    this.modules.push(module);
    this.logger.debug(`Module registered: ${module.name}`);
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
          await this.initializeModules();
          this.setupEventHandlers();
          resolve();
        } catch (error) {
          this.logger.error("Failed to initialize modules", error);
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

    for (const module of this.modules) {
      try {
        await module.onDisconnected?.();
      } catch (error) {
        this.logger.error(`Failed to disconnect module: ${module.name}`, error);
      }
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
  }

  async shutdown(): Promise<void> {
    // Stop all presence channels
    for (const channel of this.presenceChannels) {
      try {
        await channel.stop();
      } catch (error) {
        this.logger.error("Failed to stop presence channel", error);
      }
    }
    this.presenceChannels.clear();

    for (const module of this.modules) {
      try {
        await module.onShutdown?.();
      } catch (error) {
        this.logger.error(`Failed to shutdown module: ${module.name}`, error);
      }
    }
    await this.disconnect();
  }

  getSocket(): Socket | null {
    return this.socket;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Create a presence channel with custom options
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
   * Join a room with presence (convenience method)
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

  private async initializeModules(): Promise<void> {
    if (!this.socket) {
      throw new Error("Socket not initialized");
    }

    const context: ClientModuleContext = {
      socket: this.socket,
      logger: this.logger,
      config: this.config,
    };

    for (const module of this.modules) {
      try {
        await module.onConnected?.(context);
        this.logger.debug(`Module initialized: ${module.name}`);
      } catch (error) {
        this.logger.error(`Failed to initialize module: ${module.name}`, error);
        throw error;
      }
    }
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on("disconnect", async (reason: string) => {
      this.logger.warn("Socket disconnected", { reason });

      for (const module of this.modules) {
        try {
          await module.onDisconnected?.();
        } catch (error) {
          this.logger.error(`Module disconnect handler failed: ${module.name}`, error);
        }
      }
    });

    this.socket.on("reconnect", (attempt: number) => {
      this.logger.info("Socket reconnected", { attempt });

      this.initializeModules().catch((error) => {
        this.logger.error("Failed to reinitialize modules after reconnect", error);
      });
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
