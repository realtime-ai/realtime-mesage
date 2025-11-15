export type ChannelMetadataOperation = "set" | "update" | "remove";

export interface ChannelMetadataItem {
  key: string;
  value?: string;
  revision?: number;
}

export interface ChannelMetadataOptions {
  majorRevision?: number;
  lockName?: string;
  addTimestamp?: boolean;
  addUserId?: boolean;
}

export interface ChannelMetadataEntry {
  value: string;
  revision: number;
  updated?: string;
  authorUid?: string;
}

export type ChannelMetadataRecord = Record<string, ChannelMetadataEntry>;

export interface ChannelMetadataResponse {
  timestamp: number;
  channelName: string;
  channelType: string;
  totalCount: number;
  majorRevision: number;
  metadata: ChannelMetadataRecord;
}

export interface ChannelMetadataEvent {
  channelName: string;
  channelType: string;
  operation: ChannelMetadataOperation;
  items: ChannelMetadataItem[];
  majorRevision: number;
  timestamp: number;
  authorUid?: string;
}

export interface ChannelMetadataEventMap {
  metadataEvent: ChannelMetadataEvent;
}

export interface ChannelMetadataMutationParams {
  channelName: string;
  channelType: string;
  data: ChannelMetadataItem[];
  options?: ChannelMetadataOptions;
}

export interface ChannelMetadataRemovalParams {
  channelName: string;
  channelType: string;
  data?: ChannelMetadataItem[];
  options?: ChannelMetadataOptions;
}

export interface ChannelMetadataGetParams {
  channelName: string;
  channelType: string;
}
