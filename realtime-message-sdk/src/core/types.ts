import type { PresenceChannelOptions } from "../modules/presence/types";

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
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
