import type { Socket } from "socket.io";
import type { RealtimeModule, ModuleContext } from "../../src/core/types";

export interface ChatModuleOptions {
  maxHistory?: number;
}

export function createChatModule(options: ChatModuleOptions = {}): RealtimeModule {
  const maxHistory = options.maxHistory ?? 100;

  return {
    name: "chat",

    register(context: ModuleContext): void {
      context.logger.info(`Chat module registered with maxHistory=${maxHistory}`);

      context.io.on("connection", (socket: Socket) => {
        socket.on("chat:send", async (payload: any, ack?: (response: any) => void) => {
          try {
            const { roomId, message } = payload;
            const userId = socket.data.userId || socket.id;

            if (!roomId || !message) {
              ack?.({ ok: false, error: "roomId and message are required" });
              return;
            }

            const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const ts = Date.now();
            const chatMessage = {
              msgId,
              roomId,
              userId,
              message,
              ts,
            };

            const redisKey = `chat:${roomId}:messages`;
            await context.redis.zadd(redisKey, ts, JSON.stringify(chatMessage));

            const count = await context.redis.zcard(redisKey);
            if (count > maxHistory) {
              await context.redis.zremrangebyrank(redisKey, 0, count - maxHistory - 1);
            }

            context.io.to(roomId).emit("chat:message", chatMessage);

            ack?.({ ok: true, msgId, ts });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            ack?.({ ok: false, error: message });
          }
        });

        socket.on("chat:history", async (payload: any, ack?: (response: any) => void) => {
          try {
            const { roomId, limit = 50 } = payload;

            if (!roomId) {
              ack?.({ ok: false, error: "roomId is required" });
              return;
            }

            const redisKey = `chat:${roomId}:messages`;
            const messages = await context.redis.zrange(redisKey, -limit, -1);

            ack?.({
              ok: true,
              messages: messages.map((msg) => {
                try {
                  return JSON.parse(msg);
                } catch {
                  return null;
                }
              }).filter(Boolean),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            ack?.({ ok: false, error: message });
          }
        });
      });
    },
  };
}
