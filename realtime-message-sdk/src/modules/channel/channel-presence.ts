import type { Socket } from "socket.io-client";
import { EventEmitter } from "../../core/event-emitter";
import type { Logger } from "../../core/types";
import { PresenceChannel } from "../presence/presence-channel";
import type {
  PresenceChannelOptions,
  PresenceHeartbeatResponse,
  PresenceJoinResponse,
  PresenceEventEnvelope,
  ConnectionStateSnapshot,
} from "../presence/types";
import type { ChannelPresenceEvents, PresenceMember } from "./types";

/**
 * ChannelPresence manages presence operations for a specific channel.
 * It wraps PresenceChannel and provides a cleaner API scoped to a channel.
 */
export class ChannelPresence<TState = unknown> extends EventEmitter<ChannelPresenceEvents<TState>> {
  private readonly socket: Socket;
  private readonly logger: Logger;
  private readonly channelId: string;
  private readonly options: PresenceChannelOptions;
  private presenceChannel: PresenceChannel | null = null;
  private userId: string | null = null;

  constructor(
    socket: Socket,
    channelId: string,
    logger: Logger,
    options?: PresenceChannelOptions
  ) {
    super();
    this.socket = socket;
    this.channelId = channelId;
    this.logger = logger;
    this.options = options ?? {};
  }

  /**
   * Join the channel with presence
   */
  async join(userId: string, state?: TState): Promise<PresenceJoinResponse> {
    if (this.presenceChannel) {
      this.logger.warn("Already joined presence channel, leaving first");
      await this.leave();
    }

    this.userId = userId;
    this.presenceChannel = new PresenceChannel(this.socket, this.options);

    // Forward events from PresenceChannel to ChannelPresence
    this.setupEventForwarding();

    const response = await this.presenceChannel.join({
      roomId: this.channelId,
      userId,
      state: state as Record<string, unknown> | undefined,
    });

    return response;
  }

  /**
   * Update presence state (sends a heartbeat with state patch)
   */
  async updateState(patch: Partial<TState>): Promise<PresenceHeartbeatResponse> {
    if (!this.presenceChannel) {
      throw new Error("Cannot update state before joining. Call join() first.");
    }
    return this.presenceChannel.updateState(patch as Record<string, unknown>);
  }

  /**
   * Leave the presence channel
   */
  async leave(): Promise<void> {
    if (!this.presenceChannel) {
      return;
    }

    await this.presenceChannel.leave();
    this.cleanupPresenceChannel();
  }

  /**
   * Stop the presence channel (alias for leave)
   */
  async stop(): Promise<void> {
    await this.leave();
  }

  /**
   * Get current presence members
   * Note: This requires tracking the snapshot from join and presence events
   */
  async getMembers(): Promise<PresenceMember<TState>[]> {
    // TODO: Implement member tracking
    this.logger.warn("getMembers is not yet fully implemented");
    return [];
  }

  /**
   * Check if currently joined to the presence channel
   */
  isJoined(): boolean {
    return this.presenceChannel !== null;
  }

  /**
   * Get the current user ID
   */
  getUserId(): string | null {
    return this.userId;
  }

  private setupEventForwarding(): void {
    if (!this.presenceChannel) {
      return;
    }

    this.presenceChannel.on("presenceEvent", (event: PresenceEventEnvelope) => {
      switch (event.type) {
        case "join":
          this.emit("joined", event as PresenceEventEnvelope & { state?: TState });
          break;
        case "leave":
          this.emit("left", event);
          break;
        case "update":
          this.emit("updated", event as PresenceEventEnvelope & { state?: TState });
          break;
      }
    });

    this.presenceChannel.on("snapshot", (snapshot: ConnectionStateSnapshot[]) => {
      this.emit("snapshot", snapshot);
    });

    this.presenceChannel.on("error", (error: Error) => {
      this.emit("error", error);
    });
  }

  private cleanupPresenceChannel(): void {
    if (this.presenceChannel) {
      // Presence channel will clean up its own listeners
      this.presenceChannel = null;
    }
    this.userId = null;
  }
}
