const roomTag = (roomId: string) => `{room:${roomId}}`;

export const activeRoomsKey = () => "prs:active_rooms";
export const roomMembersKey = (roomId: string) => `prs:${roomTag(roomId)}:members`;
export const roomConnectionsKey = (roomId: string) => `prs:${roomTag(roomId)}:conns`;
<<<<<<< HEAD
export const roomConnMetadataKey = (roomId: string) => `prs:${roomTag(roomId)}:conn_meta`;
=======
export const roomConnUsersKey = (roomId: string) => `prs:${roomTag(roomId)}:conn_users`;
>>>>>>> origin/main
export const roomLastSeenKey = (roomId: string) => `prs:${roomTag(roomId)}:last_seen`;
export const roomEventsChannel = (roomId: string) => `prs:${roomTag(roomId)}:events`;
export const connKey = (connId: string) => `prs:conn:${connId}`;
export const userConnsKey = (userId: string) => `prs:user:${userId}:conns`;
export const eventsPattern = "prs:{room:*}:events";
