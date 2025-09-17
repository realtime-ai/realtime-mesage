export interface ConnectionStateSnapshot {
  connId: string;
  userId: string;
  state: Record<string, unknown> | null;
  lastSeenMs: number;
  epoch: number;
}

export interface PresenceEventEnvelope {
  type: "join" | "leave" | "update";
  roomId: string;
  userId: string;
  connId: string;
  state?: Record<string, unknown> | null;
  ts: number;
  epoch?: number;
}

export interface PresenceJoinAck {
  ok: true;
  snapshot: ConnectionStateSnapshot[];
  self: { connId: string; epoch: number };
}

export interface PresenceJoinError {
  ok: false;
  error: string;
}

export interface PresenceHeartbeatAck {
  ok: true;
  changed: boolean;
  epoch?: number;
}

export interface PresenceHeartbeatError {
  ok: false;
  error: string;
}

export type PresenceJoinResponse = PresenceJoinAck | PresenceJoinError;
export type PresenceHeartbeatResponse = PresenceHeartbeatAck | PresenceHeartbeatError;

export interface PresenceStatePatch {
  [key: string]: unknown;
}

export interface PresenceJoinParams {
  roomId: string;
  userId: string;
  state?: Record<string, unknown>;
}

export interface PresenceHeartbeatParams {
  patchState?: PresenceStatePatch;
}

export interface PresenceClientConfig {
  /** Base URL of the realtime presence server */
  baseUrl: string;
  /** Optional auth handshake hook */
  authProvider?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Custom logger implementation */
  logger?: Logger;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export type PresenceChannelEventMap = {
  connected: { connId: string };
  disconnected: { reason: string };
  joinAck: PresenceJoinResponse;
  heartbeatAck: PresenceHeartbeatResponse;
  presenceEvent: PresenceEventEnvelope;
  snapshot: ConnectionStateSnapshot[];
  error: Error;
};

export interface PresenceChannelOptions {
  /** Milliseconds between automatic heartbeats. Defaults to 10s. */
  heartbeatIntervalMs?: number;
  /** Milliseconds to wait for heartbeat acknowledgements before counting as missed. */
  heartbeatAckTimeoutMs?: number;
  /** Optional custom event name the server uses for presence fanout. */
  presenceEventName?: string;
  /** Number of missed heartbeat acknowledgements tolerated before reconnect. */
  maxMissedHeartbeats?: number;
}

export interface CustomEmitOptions {
  /** Whether to wait for an acknowledgement callback. Defaults to false. */
  ack?: boolean;
  /** Timeout in milliseconds when waiting for an acknowledgement. */
  timeoutMs?: number;
}
