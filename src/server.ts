import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { z } from "zod";

import { config } from "./config";
import { PresenceService } from "./presence/presence-service";
import type { PresenceSnapshotEntry } from "./presence/types";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const pubClient = new Redis(config.redisUrl);
const subClient = new Redis(config.redisUrl);
io.adapter(createAdapter(pubClient, subClient));

const commandRedis = new Redis(config.redisUrl);
const presenceService = new PresenceService(commandRedis, {
  ttlMs: config.presenceTtlMs,
  reaperIntervalMs: config.reaperIntervalMs,
  reaperLookbackMs: config.reaperLookbackMs,
});

let unsubscribePresenceEvents: (() => Promise<void>) | null = null;

presenceService
  .subscribe((event) => {
    io.to(event.roomId).emit("presence:event", event);
  })
  .then((unsubscribe) => {
    unsubscribePresenceEvents = unsubscribe;
  })
  .catch((error) => {
    console.error("Failed to subscribe to presence events", error);
  });
presenceService.startReaper();

const JoinSchema = z.object({
  roomId: z.string().min(1),
  userId: z.string().min(1),
  state: z.record(z.string(), z.unknown()).optional(),
});

const HeartbeatSchema = z.object({
  patchState: z.record(z.string(), z.unknown()).optional(),
});

type JoinAck = (
  response:
    | { ok: true; snapshot: PresenceSnapshotEntry[] }
    | { ok: false; error: string }
) => void;

type HeartbeatAck = (
  response: { ok: true; changed: boolean } | { ok: false; error: string }
) => void;

type LeaveAck = (
  response: { ok: true } | { ok: false; error: string }
) => void;

io.on("connection", (socket) => {
  socket.on("presence:join", async (raw: unknown, ack?: JoinAck) => {
    try {
      const payload = JoinSchema.parse(raw);

      if (socket.data.presenceRoomId && socket.data.presenceRoomId !== payload.roomId) {
        throw new Error("Socket already joined a different presence room");
      }

      await socket.join(payload.roomId);
      try {
        const snapshot = await presenceService.join({
          roomId: payload.roomId,
          userId: payload.userId,
          connId: socket.id,
          state: payload.state,
        });

        socket.data.presenceRoomId = payload.roomId;
        socket.data.presenceUserId = payload.userId;

        ack?.({ ok: true, snapshot });
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
      const changed = await presenceService.heartbeat({
        connId: socket.id,
        patchState: payload.patchState,
      });
      ack?.({ ok: true, changed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      ack?.({ ok: false, error: message });
    }
  });

  socket.on("presence:leave", async (_raw: unknown, ack?: LeaveAck) => {
    try {
      const result = await presenceService.leave(socket.id);
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
      await presenceService.leave(socket.id);
    } catch (error) {
      console.error("Failed to cleanup presence on disconnect", error);
    }
  });
});

const port = config.port;
httpServer.listen(port, () => {
  console.log(`Presence server listening on port ${port}`);
});

process.on("SIGINT", async () => {
  await shutdown();
});

process.on("SIGTERM", async () => {
  await shutdown();
});

async function shutdown() {
  console.log("Shutting down presence server...");
  if (unsubscribePresenceEvents) {
    try {
      await unsubscribePresenceEvents();
    } catch (error) {
      console.error("Failed to unsubscribe from presence events", error);
    }
    unsubscribePresenceEvents = null;
  }
  await presenceService.stop();
  await Promise.all([pubClient.quit(), subClient.quit(), commandRedis.quit()]);
  httpServer.close(() => {
    process.exit(0);
  });
}
