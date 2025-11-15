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
  metadataEventName?: string;
}

export interface PresenceEventBridge {
  stop(): Promise<void>;
}

export type ChannelMetadataOperation = "set" | "update" | "remove";

export interface ChannelMetadataItemInput {
  key: string;
  value?: string;
  revision?: number;
}

export interface ChannelMetadataEntry {
  value: string;
  revision: number;
  updated?: string;
  authorUid?: string;
}

export type ChannelMetadataRecord = Record<string, ChannelMetadataEntry>;

export interface ChannelMetadataOptions {
  majorRevision?: number;
  lockName?: string;
  addTimestamp?: boolean;
  addUserId?: boolean;
}

export interface ChannelMetadataResponse {
  timestamp: number;
  channelName: string;
  channelType: string;
  totalCount: number;
  majorRevision: number;
  metadata: ChannelMetadataRecord;
}

export interface ChannelMetadataEventPayload {
  channelName: string;
  channelType: string;
  operation: ChannelMetadataOperation;
  items: ChannelMetadataItemInput[];
  majorRevision: number;
  timestamp: number;
  authorUid?: string;
}

export type ChannelMetadataEventHandler = (
  event: ChannelMetadataEventPayload
) => void | Promise<void>;

export interface ChannelMetadataMutationParams {
  channelName: string;
  channelType: string;
  data: ChannelMetadataItemInput[];
  options?: ChannelMetadataOptions;
  actorUserId?: string;
}

export interface ChannelMetadataRemovalParams {
  channelName: string;
  channelType: string;
  data?: ChannelMetadataItemInput[];
  options?: ChannelMetadataOptions;
  actorUserId?: string;
}

export interface ChannelMetadataGetParams {
  channelName: string;
  channelType: string;
}

