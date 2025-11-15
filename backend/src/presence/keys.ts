const roomTag = (roomId: string) => `{room:${roomId}}`;
const channelTag = (channelType: string, channelName: string) =>
  `{chan:${channelType}:${channelName}}`;

export const activeRoomsKey = () => "prs:active_rooms";
export const roomMembersKey = (roomId: string) => `prs:${roomTag(roomId)}:members`;
export const roomConnectionsKey = (roomId: string) => `prs:${roomTag(roomId)}:conns`;
export const roomConnMetadataKey = (roomId: string) => `prs:${roomTag(roomId)}:conn_meta`;
export const roomLastSeenKey = (roomId: string) => `prs:${roomTag(roomId)}:last_seen`;
export const roomEventsChannel = (roomId: string) => `prs:${roomTag(roomId)}:events`;
export const connKey = (connId: string) => `prs:conn:${connId}`;
export const userConnsKey = (userId: string) => `prs:user:${userId}:conns`;
export const eventsPattern = "prs:{room:*}:events";
export const channelMetadataKey = (channelType: string, channelName: string) =>
  `prs:${channelTag(channelType, channelName)}:meta`;
export const channelMetadataEventsChannel = (
  channelType: string,
  channelName: string
) => `prs:${channelTag(channelType, channelName)}:meta_events`;
export const metadataEventsPattern = "prs:{chan:*}:meta_events";
export const lockKey = (lockName: string) => `prs:lock:${lockName}`;

