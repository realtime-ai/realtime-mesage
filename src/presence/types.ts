export type PresenceEventType = "join" | "leave" | "update";

export interface PresenceEventPayload {
  type: PresenceEventType;
  roomId: string;
  userId: string;
  connId: string;
  state?: Record<string, unknown> | null;
  ts: number;
  epoch?: number;
}

export interface PresenceSnapshotEntry {
  connId: string;
  userId: string;
  state: Record<string, unknown> | null;
  lastSeenMs: number;
  epoch: number;
}

export interface JoinOptions {
  roomId: string;
  userId: string;
  connId: string;
  state?: Record<string, unknown> | undefined;
}

export interface HeartbeatOptions {
  connId: string;
  patchState?: Record<string, unknown> | undefined;
}

export interface LeaveOptions {
  connId: string;
}
