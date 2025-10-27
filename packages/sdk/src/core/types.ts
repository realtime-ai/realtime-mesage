import type { Socket } from "socket.io-client";
import type { PresenceChannelOptions } from "../modules/presence/types";

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface ClientModuleContext {
  socket: Socket;
  logger: Logger;
  config: RealtimeClientConfig;
}

export interface ClientModule {
  name: string;
  onConnected?(context: ClientModuleContext): void | Promise<void>;
  onDisconnected?(): void | Promise<void>;
  onShutdown?(): void | Promise<void>;
}

export interface RealtimeClientConfig {
  baseUrl: string;
  authProvider?: () => Promise<Record<string, string>> | Record<string, string>;
  logger?: Logger;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelayMax?: number;
  presence?: PresenceChannelOptions;
}
