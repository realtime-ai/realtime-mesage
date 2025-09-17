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

export type PresenceEventHandler = (
  event: PresenceEventPayload
) => void | Promise<void>;

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
  epoch?: number | undefined;
}

export interface LeaveOptions {
  connId: string;
}

export interface PresenceConnectionMetadata {
  userId: string;
  epoch: number;
}

export interface PresenceSocketRoomEmitter {
  emit(event: string, payload: PresenceEventPayload): unknown;
}

export interface PresenceSocketAdapter {
  to(roomId: string): PresenceSocketRoomEmitter;
}

export interface PresenceEventBridgeOptions {
  eventName?: string;
}

export interface PresenceEventBridge {
  stop(): Promise<void>;
}
