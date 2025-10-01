import type { ClientModule, ClientModuleContext } from "../../core/types";
import { PresenceChannel } from "./presence-channel";
import type {
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceChannelOptions,
} from "./types";

export interface PresenceModuleAPI {
  createChannel(options?: PresenceChannelOptions): PresenceChannel;
  joinRoom(
    params: PresenceJoinParams,
    options?: PresenceChannelOptions
  ): Promise<{
    channel: PresenceChannel;
    response: PresenceJoinResponse;
  }>;
}

export function createPresenceModule(): ClientModule & { api: PresenceModuleAPI } {
  let context: ClientModuleContext | null = null;
  const channels = new Set<PresenceChannel>();

  const api: PresenceModuleAPI = {
    createChannel(options?: PresenceChannelOptions): PresenceChannel {
      if (!context) {
        throw new Error("Presence module not initialized");
      }
      const channel = new PresenceChannel(context.socket, options);
      channels.add(channel);
      return channel;
    },

    async joinRoom(params, options) {
      const channel = api.createChannel(options);
      const response = await channel.join(params);
      return { channel, response };
    },
  };

  return {
    name: "presence",
    api,

    onConnected(ctx: ClientModuleContext) {
      context = ctx;
      ctx.logger.debug("Presence module initialized");
    },

    async onDisconnected() {
      for (const channel of channels) {
        try {
          await channel.stop();
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
      channels.clear();
    },

    async onShutdown() {
      await this.onDisconnected?.();
      context = null;
    },
  };
}

export { PresenceChannel } from "./presence-channel";
export type { CustomEmitOptions } from "./presence-channel";
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
} from "./types";
