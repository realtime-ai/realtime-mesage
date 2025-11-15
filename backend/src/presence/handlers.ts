import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { connKey } from "./keys";
import type { PresenceService } from "./service";
import { MetadataError } from "./service";
import type {
  ChannelMetadataResponse,
  PresenceSnapshotEntry,
} from "./types";
import type { HeartbeatBatcher } from "./heartbeat-batcher";
import type { LuaHeartbeatExecutor } from "./lua-heartbeat-executor";
import type { TransactionalMetadataWrapper } from "./metadata-transactional";

export interface PresenceHandlerContext {
  io: Server;
  redis: Redis;
  logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  heartbeatBatcher?: HeartbeatBatcher | null;
  luaHeartbeatExecutor?: LuaHeartbeatExecutor | null;
  transactionalMetadata?: TransactionalMetadataWrapper | null;
}

const JoinSchema = z.object({
  roomId: z.string().min(1),
  userId: z.string().min(1),
  state: z.record(z.string(), z.unknown()).optional(),
});

const HeartbeatSchema = z.object({
  patchState: z.record(z.string(), z.unknown()).optional(),
  epoch: z.coerce.number().int().nonnegative().optional(),
});

const MetadataOptionsSchema = z
  .object({
    majorRevision: z.coerce.number().int().optional(),
    lockName: z.string().min(1).optional(),
    addTimestamp: z.boolean().optional(),
    addUserId: z.boolean().optional(),
  })
  .optional();

const MetadataItemSchema = z.object({
  key: z.string().min(1),
  value: z.string().optional(),
  revision: z.coerce.number().int().optional(),
});

const MetadataSetSchema = z.object({
  channelName: z.string().min(1),
  channelType: z.string().min(1),
  data: z.array(MetadataItemSchema).default([]),
  options: MetadataOptionsSchema,
});

const MetadataUpdateSchema = z.object({
  channelName: z.string().min(1),
  channelType: z.string().min(1),
  data: z.array(MetadataItemSchema).min(1),
  options: MetadataOptionsSchema,
});

const MetadataRemoveSchema = z.object({
  channelName: z.string().min(1),
  channelType: z.string().min(1),
  data: z.array(MetadataItemSchema).optional(),
  options: MetadataOptionsSchema,
});

const MetadataGetSchema = z.object({
  channelName: z.string().min(1),
  channelType: z.string().min(1),
});

type JoinAck = (
  response:
    | {
        ok: true;
        snapshot: PresenceSnapshotEntry[];
        self: { connId: string; epoch: number };
      }
    | { ok: false; error: string }
) => void;

type HeartbeatAck = (
  response:
    | { ok: true; changed: boolean; epoch?: number }
    | { ok: false; error: string }
) => void;

type LeaveAck = (
  response: { ok: true } | { ok: false; error: string }
) => void;

type MetadataAck =
  | ((
      response:
        | ({ ok: true } & ChannelMetadataResponse)
        | { ok: false; error: string; code?: string }
    ) => void)
  | undefined;

const respondMetadataSuccess = (ack: MetadataAck, data: ChannelMetadataResponse): void => {
  ack?.({ ok: true, ...data });
};

const respondMetadataError = (
  ack: MetadataAck,
  error: unknown,
  logger: Pick<Console, "debug" | "info" | "warn" | "error">
): void => {
  const message = error instanceof Error ? error.message : "Unknown metadata error";
  const code = error instanceof MetadataError ? error.code : undefined;
  if (ack) {
    if (code) {
      ack({ ok: false, error: message, code });
    } else {
      ack({ ok: false, error: message });
    }
  }
  logger.warn("Metadata operation failed", { message, code });
};

export function registerPresenceHandlers(
  context: PresenceHandlerContext,
  service: PresenceService
): void {
  context.io.on("connection", (socket: Socket) => {
    socket.on("presence:join", async (raw: unknown, ack?: JoinAck) => {
      try {
        const payload = JoinSchema.parse(raw);

        if (socket.data.presenceRoomId && socket.data.presenceRoomId !== payload.roomId) {
          throw new Error("Socket already joined a different presence room");
        }

        await socket.join(payload.roomId);
        try {
          const snapshot = await service.join({
            roomId: payload.roomId,
            userId: payload.userId,
            connId: socket.id,
            state: payload.state,
          });

          socket.data.presenceRoomId = payload.roomId;
          socket.data.presenceUserId = payload.userId;

          const selfEntry = snapshot.find((entry) => entry.connId === socket.id);
          let epoch = selfEntry?.epoch;
          if (epoch === undefined || Number.isNaN(epoch)) {
            const storedEpoch = await context.redis.hget(connKey(socket.id), "epoch");
            epoch = storedEpoch ? Number(storedEpoch) : Date.now();
          }

          ack?.({
            ok: true,
            snapshot,
            self: { connId: socket.id, epoch },
          });
        } catch (error) {
          await socket.leave(payload.roomId);
          throw error;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        ack?.({ ok: false, error: message });
      }
    });

    socket.on("presence:heartbeat", async (raw: unknown, ack?: HeartbeatAck) => {
      try {
        const payload = HeartbeatSchema.parse(raw ?? {});
        const heartbeatOptions = {
          connId: socket.id,
          patchState: payload.patchState,
          epoch: payload.epoch,
        };

        let changed: boolean;

        // 优先使用 Lua 脚本优化
        if (context.luaHeartbeatExecutor) {
          changed = await context.luaHeartbeatExecutor.heartbeat(heartbeatOptions);
          const epoch = await context.luaHeartbeatExecutor.getEpoch(socket.id);
          const response: Parameters<HeartbeatAck>[0] = epoch !== undefined
            ? { ok: true, changed, epoch }
            : { ok: true, changed };
          ack?.(response);
          return;
        }

        // 次选使用批处理
        if (context.heartbeatBatcher) {
          changed = await context.heartbeatBatcher.heartbeat(heartbeatOptions);
          const epochRaw = await context.redis.hget(connKey(socket.id), "epoch");
          const response: Parameters<HeartbeatAck>[0] = epochRaw
            ? { ok: true, changed, epoch: Number(epochRaw) }
            : { ok: true, changed };
          ack?.(response);
          return;
        }

        // 默认使用原有逻辑
        changed = await service.heartbeat(heartbeatOptions);
        const epochRaw = await context.redis.hget(connKey(socket.id), "epoch");
        const response: Parameters<HeartbeatAck>[0] = epochRaw
          ? { ok: true, changed, epoch: Number(epochRaw) }
          : { ok: true, changed };
        ack?.(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        ack?.({ ok: false, error: message });
      }
    });

    socket.on("presence:leave", async (_raw: unknown, ack?: LeaveAck) => {
      try {
        const result = await service.leave(socket.id);
        if (result?.roomId) {
          await socket.leave(result.roomId);
        }
        socket.data.presenceRoomId = undefined;
        socket.data.presenceUserId = undefined;
        ack?.({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        ack?.({ ok: false, error: message });
      }
    });

    socket.on("metadata:setChannel", async (raw: unknown, ack?: MetadataAck) => {
      try {
        const payload = MetadataSetSchema.parse(raw ?? {});
        const params = {
          ...payload,
          actorUserId: socket.data.presenceUserId,
        };

        // 使用事务性 Metadata（如果启用）
        const response = context.transactionalMetadata
          ? await context.transactionalMetadata.setChannelMetadata(params)
          : await service.setChannelMetadata(params);

        respondMetadataSuccess(ack, response);
      } catch (error) {
        respondMetadataError(ack, error, context.logger);
      }
    });

    socket.on("metadata:updateChannel", async (raw: unknown, ack?: MetadataAck) => {
      try {
        const payload = MetadataUpdateSchema.parse(raw ?? {});
        const params = {
          ...payload,
          actorUserId: socket.data.presenceUserId,
        };

        // 使用事务性 Metadata（如果启用）
        const response = context.transactionalMetadata
          ? await context.transactionalMetadata.updateChannelMetadata(params)
          : await service.updateChannelMetadata(params);

        respondMetadataSuccess(ack, response);
      } catch (error) {
        respondMetadataError(ack, error, context.logger);
      }
    });

    socket.on("metadata:removeChannel", async (raw: unknown, ack?: MetadataAck) => {
      try {
        const payload = MetadataRemoveSchema.parse(raw ?? {});
        const params = {
          ...payload,
          actorUserId: socket.data.presenceUserId,
        };

        // 使用事务性 Metadata（如果启用）
        const response = context.transactionalMetadata
          ? await context.transactionalMetadata.removeChannelMetadata(params)
          : await service.removeChannelMetadata(params);

        respondMetadataSuccess(ack, response);
      } catch (error) {
        respondMetadataError(ack, error, context.logger);
      }
    });

    socket.on("metadata:getChannel", async (raw: unknown, ack?: MetadataAck) => {
      try {
        const payload = MetadataGetSchema.parse(raw ?? {});
        const response = await service.getChannelMetadata(payload);
        respondMetadataSuccess(ack, response);
      } catch (error) {
        respondMetadataError(ack, error, context.logger);
      }
    });

    socket.on("disconnect", async () => {
      try {
        await service.leave(socket.id);
      } catch (error) {
        context.logger.error("Failed to cleanup presence on disconnect", error);
      }
    });
  });
}
