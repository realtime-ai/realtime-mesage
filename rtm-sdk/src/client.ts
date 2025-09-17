import type {
  PresenceChannelOptions,
  PresenceClientConfig,
  PresenceJoinParams,
  PresenceHeartbeatParams,
  PresenceHeartbeatResponse,
  PresenceJoinResponse,
  PresenceStatePatch,
  CustomEmitOptions,
  ClientHooks,
  ClientEventMap,
} from "./types";
import { SocketPresenceTransport } from "./transport/socket-transport";
import { PresenceChannel } from "./presence/presence-channel";
import { EventEmitter } from "./utils/event-emitter";

export class RealtimeMessageClient {
  private readonly transport: SocketPresenceTransport;
  private readonly events = new EventEmitter<ClientEventMap>();
  private readonly userHooks: ClientHooks;

  constructor(private readonly config: PresenceClientConfig) {
    if (!config.baseUrl) {
      throw new Error("PresenceClientConfig.baseUrl is required");
    }
    this.userHooks = config.hooks ?? {};
    const combinedHooks: ClientHooks = {
      onConnect: (info) => {
        this.events.emit("connect", info);
        this.userHooks.onConnect?.(info);
      },
      onDisconnect: (info) => {
        this.events.emit("disconnect", info);
        this.userHooks.onDisconnect?.(info);
      },
      onReconnect: (info) => {
        this.events.emit("reconnect", info);
        this.userHooks.onReconnect?.(info);
      },
      onReconnectAttempt: (info) => {
        this.events.emit("reconnectAttempt", info);
        this.userHooks.onReconnectAttempt?.(info);
      },
      onMessage: (eventName, payload) => {
        this.events.emit("message", { event: eventName, payload });
        this.userHooks.onMessage?.(eventName, payload);
      },
    };

    const transportConfig: PresenceClientConfig = {
      ...config,
      hooks: combinedHooks,
    };

    this.transport = new SocketPresenceTransport(transportConfig);
  }

  createChannel(options?: PresenceChannelOptions): PresenceChannel {
    return new PresenceChannel(this.transport, options);
  }

  async joinRoom(
    params: PresenceJoinParams,
    options?: PresenceChannelOptions
  ): Promise<{
    channel: PresenceChannel;
    response: PresenceJoinResponse;
  }> {
    const channel = this.createChannel(options);
    const response = await channel.join(params);
    return { channel, response };
  }

  async sendHeartbeat(
    channel: PresenceChannel,
    patch?: PresenceHeartbeatParams | PresenceStatePatch
  ): Promise<PresenceHeartbeatResponse> {
    if (!patch) {
      return channel.sendHeartbeat();
    }

    if ("patchState" in patch) {
      return channel.sendHeartbeat(patch);
    }
    const patchState = patch as PresenceStatePatch;
    return channel.sendHeartbeat({ patchState });
  }

  emit(channel: PresenceChannel, eventName: string): void;
  emit(channel: PresenceChannel, eventName: string, payload: unknown): void;
  emit<T>(
    channel: PresenceChannel,
    eventName: string,
    ack: (response: T) => void
  ): void;
  emit<T>(
    channel: PresenceChannel,
    eventName: string,
    payload: unknown,
    ack: (response: T) => void
  ): void;
  emit<T>(
    channel: PresenceChannel,
    eventName: string,
    payload: unknown,
    options: CustomEmitOptions
  ): Promise<T>;
  emit<T = unknown>(
    channel: PresenceChannel,
    eventName: string,
    payloadOrAck?: unknown | ((response: T) => void),
    ackOrOptions?: ((response: T) => void) | CustomEmitOptions
  ): Promise<T | void> | void {
    return channel.emit<T>(eventName, payloadOrAck as any, ackOrOptions as any);
  }

  async shutdown(): Promise<void> {
    await this.transport.disconnect();
  }

  onConnect(handler: (info: ClientEventMap["connect"]) => void): () => void {
    return this.events.on("connect", handler);
  }

  onDisconnect(handler: (info: ClientEventMap["disconnect"]) => void): () => void {
    return this.events.on("disconnect", handler);
  }

  onReconnect(handler: (info: ClientEventMap["reconnect"]) => void): () => void {
    return this.events.on("reconnect", handler);
  }

  onReconnectAttempt(handler: (info: ClientEventMap["reconnectAttempt"]) => void): () => void {
    return this.events.on("reconnectAttempt", handler);
  }

  onMessage(handler: (event: string, payload: unknown) => void): () => void {
    return this.events.on("message", ({ event, payload }) => handler(event, payload));
  }
}
