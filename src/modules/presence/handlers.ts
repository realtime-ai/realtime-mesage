import type { Socket } from "socket.io";
import { z } from "zod";
import type { ModuleContext } from "../../core/types";
import type { PresenceService } from "./service";
import { connKey } from "./keys";
import type { PresenceSnapshotEntry } from "./types";

const JoinSchema = z.object({
  roomId: z.string().min(1),
  userId: z.string().min(1),
  state: z.record(z.string(), z.unknown()).optional(),
});

const HeartbeatSchema = z.object({
  patchState: z.record(z.string(), z.unknown()).optional(),
  epoch: z.coerce.number().int().nonnegative().optional(),
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

export function registerPresenceHandlers(
  context: ModuleContext,
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
        const changed = await service.heartbeat({
          connId: socket.id,
          patchState: payload.patchState,
          epoch: payload.epoch,
        });
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

    socket.on("disconnect", async () => {
      try {
        await service.leave(socket.id);
      } catch (error) {
        context.logger.error("Failed to cleanup presence on disconnect", error);
      }
    });
  });
}
