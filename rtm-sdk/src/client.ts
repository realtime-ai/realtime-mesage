import type {
  PresenceChannelOptions,
  PresenceClientConfig,
  PresenceJoinParams,
  PresenceHeartbeatParams,
  PresenceHeartbeatResponse,
  PresenceJoinResponse,
  PresenceStatePatch,
  CustomEmitOptions,
} from "./types";
import { SocketPresenceTransport } from "./transport/socket-transport";
import { PresenceChannel } from "./presence/presence-channel";

export class RealtimeMessageClient {
  private readonly transport: SocketPresenceTransport;

  constructor(private readonly config: PresenceClientConfig) {
    if (!config.baseUrl) {
      throw new Error("PresenceClientConfig.baseUrl is required");
    }
    this.transport = new SocketPresenceTransport(config);
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

  sendCustomMessage(channel: PresenceChannel, eventName: string): void;
  sendCustomMessage(channel: PresenceChannel, eventName: string, payload: unknown): void;
  sendCustomMessage<T>(
    channel: PresenceChannel,
    eventName: string,
    ack: (response: T) => void
  ): void;
  sendCustomMessage<T>(
    channel: PresenceChannel,
    eventName: string,
    payload: unknown,
    ack: (response: T) => void
  ): void;
  sendCustomMessage<T>(
    channel: PresenceChannel,
    eventName: string,
    payload: unknown,
    options: CustomEmitOptions
  ): Promise<T>;
  sendCustomMessage<T = unknown>(
    channel: PresenceChannel,
    eventName: string,
    payloadOrAck?: unknown | ((response: T) => void),
    ackOrOptions?: ((response: T) => void) | CustomEmitOptions
  ): Promise<T | void> | void {
    return channel.sendCustomMessage<T>(eventName, payloadOrAck as any, ackOrOptions as any);
  }

  async shutdown(): Promise<void> {
    await this.transport.disconnect();
  }
}
