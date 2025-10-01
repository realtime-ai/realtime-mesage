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
  heartbeatIntervalMs?: number;
  heartbeatAckTimeoutMs?: number;
  presenceEventName?: string;
  maxMissedHeartbeats?: number;
}
