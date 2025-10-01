import type { ClientModule, ClientModuleContext } from "../../src/core/types";

export interface Message {
  msgId: string;
  roomId: string;
  userId: string;
  message: string;
  ts: number;
}

export interface ChatModuleAPI {
  sendMessage(roomId: string, message: string): Promise<{ msgId: string; ts: number }>;
  getHistory(roomId: string, limit?: number): Promise<Message[]>;
  onMessage(handler: (msg: Message) => void): () => void;
}

export function createChatModule(): ClientModule & { api: ChatModuleAPI } {
  let context: ClientModuleContext | null = null;
  const messageHandlers = new Set<(msg: Message) => void>();

  const api: ChatModuleAPI = {
    async sendMessage(roomId: string, message: string): Promise<{ msgId: string; ts: number }> {
      if (!context) {
        throw new Error("Chat module not initialized");
      }

      return new Promise((resolve, reject) => {
        context.socket.emit("chat:send", { roomId, message }, (response: any) => {
          if (response?.ok) {
            resolve({ msgId: response.msgId, ts: response.ts });
          } else {
            reject(new Error(response?.error || "Failed to send message"));
          }
        });
      });
    },

    async getHistory(roomId: string, limit = 50): Promise<Message[]> {
      if (!context) {
        throw new Error("Chat module not initialized");
      }

      return new Promise((resolve, reject) => {
        context.socket.emit("chat:history", { roomId, limit }, (response: any) => {
          if (response?.ok) {
            resolve(response.messages || []);
          } else {
            reject(new Error(response?.error || "Failed to get history"));
          }
        });
      });
    },

    onMessage(handler: (msg: Message) => void): () => void {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
  };

  return {
    name: "chat",
    api,

    onConnected(ctx: ClientModuleContext) {
      context = ctx;

      // Listen for chat messages from server
      ctx.socket.on("chat:message", (msg: Message) => {
        ctx.logger.debug("Received chat message", msg);
        messageHandlers.forEach((handler) => {
          try {
            handler(msg);
          } catch (error) {
            ctx.logger.error("Chat message handler error", error);
          }
        });
      });

      ctx.logger.info("Chat module initialized");
    },

    async onDisconnected() {
      if (context) {
        context.logger.info("Chat module disconnected");
      }
    },

    async onShutdown() {
      if (context) {
        context.socket.off("chat:message");
        context.logger.info("Chat module shut down");
      }
      messageHandlers.clear();
      context = null;
    },
  };
}
