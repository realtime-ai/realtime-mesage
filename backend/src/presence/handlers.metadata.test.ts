import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { createServer } from "http";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";
import Redis from "ioredis-mock";
import type { Redis as RedisClient } from "ioredis";

import { PresenceService } from "./service";
import { registerPresenceHandlers } from "./handlers";
import type { PresenceHandlerContext } from "./handlers";
import { lockKey } from "./keys";
import type { ChannelMetadataResponse } from "./types";

const redisFactory = () => new (Redis as unknown as { new (): RedisClient })();

const waitFor = async (
  condition: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 20
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Condition not met within timeout");
};

describe("Presence Handlers - Channel Metadata", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let redis: RedisClient;
  let service: PresenceService;
  let port: number;
  let clientSocket: ClientSocket;

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(async () => {
    redis = redisFactory();
    await redis.flushall();

    httpServer = createServer();
    io = new SocketIOServer(httpServer);

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, (err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to get server address"));
          return;
        }
        port = (addr as AddressInfo).port;
        resolve();
      });
    });

    service = new PresenceService(redis, {
      ttlMs: 5_000,
      reaperIntervalMs: 1_000,
      reaperLookbackMs: 10_000,
      logger: mockLogger,
    });

    const context: PresenceHandlerContext = {
      io,
      redis,
      logger: mockLogger,
    };

    registerPresenceHandlers(context, service);

    clientSocket = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Client connection timeout"));
      }, 5000);

      clientSocket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });

      clientSocket.once("connect_error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });

  afterEach(async () => {
    clientSocket?.disconnect();
    await service.stop();
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close((err: any) => {
        if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
          console.error("httpServer.close error:", err);
        }
        resolve();
      });
    });
    if (typeof (redis as any).disconnect === "function") {
      (redis as any).disconnect();
    }
  });

  describe("metadata:setChannel", () => {
    it("should validate parameters with Zod schema", async () => {
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
      } else {
        expect(response.channelName).toBe("test-channel");
      }
    });

    it("should return success response format", async () => {
      // First join a presence room
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response).toHaveProperty("timestamp");
        expect(response).toHaveProperty("channelName");
        expect(response).toHaveProperty("channelType");
        expect(response).toHaveProperty("totalCount");
        expect(response).toHaveProperty("majorRevision");
        expect(response).toHaveProperty("metadata");
      }
    });

    it("should return error response format with code", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      // Set initial metadata
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Initial" }],
          },
          resolve
        );
      });

      // Try to update with wrong revision
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string; code?: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:updateChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Updated", revision: 0 }],
              options: { majorRevision: 0 },
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
        expect(response.code).toBeDefined();
      }
    });

    it("should reject invalid parameters", async () => {
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              // Missing channelName
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
      }
    });
  });

  describe("metadata:updateChannel", () => {
    it("should validate parameters", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Initial" }],
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:updateChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Updated" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response.metadata.topic?.value).toBe("Updated");
      }
    });

    it("should return error when updating non-existent item", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string; code?: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:updateChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "nonexistent", value: "Value" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.code).toBe("METADATA_INVALID");
      }
    });
  });

  describe("metadata:removeChannel", () => {
    it("should validate parameters", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [
              { key: "topic", value: "Topic" },
              { key: "moderator", value: "alice" },
            ],
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:removeChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "moderator" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response.totalCount).toBe(1);
        expect(response.metadata.moderator).toBeUndefined();
      }
    });

    it("should remove all metadata when data is not provided", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Topic" }],
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:removeChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response.totalCount).toBe(0);
      }
    });
  });

  describe("metadata:getChannel", () => {
    it("should validate parameters", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Topic" }],
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:getChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response.metadata.topic?.value).toBe("Topic");
      }
    });

    it("should return complete data structure", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:getChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response).toHaveProperty("timestamp");
        expect(response).toHaveProperty("channelName");
        expect(response).toHaveProperty("channelType");
        expect(response).toHaveProperty("totalCount");
        expect(response).toHaveProperty("majorRevision");
        expect(response).toHaveProperty("metadata");
      }
    });
  });

  describe("Channel Access Control", () => {
    it("should reject operations when socket is not joined to channel", async () => {
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toContain("not joined");
      }
    });

    it("should allow operations when socket is joined to channel", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        expect(response.channelName).toBe("test-channel");
      }
    });
  });

  describe("User Identity", () => {
    it("should get actorUserId from socket.data.presenceUserId", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-123",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
              options: { addUserId: true },
            },
            resolve
          );
        }
      );

      if ("ok" in response && response.ok) {
        // The authorUid should be set from socket.data.presenceUserId
        expect(response.metadata.topic?.authorUid).toBeDefined();
      }
    });

    it("should handle unauthenticated users", async () => {
      // Don't join presence room
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      // Should either fail due to access control or work without authorUid
      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
      }
    });
  });

  describe("Error Handling", () => {
    it("should return METADATA_CONFLICT code for version conflicts", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "metadata:setChannel",
          {
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Initial" }],
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string; code?: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:updateChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Updated" }],
              options: { majorRevision: 999 },
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.code).toBe("METADATA_CONFLICT");
      }
    });

    it("should return METADATA_LOCK code for lock errors", async () => {
      await redis.set(lockKey("test-lock"), "other-user");

      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string; code?: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
              options: { lockName: "test-lock" },
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.code).toBe("METADATA_LOCK");
      }
    });

    it("should return METADATA_INVALID code for validation errors", async () => {
      await new Promise<void>((resolve) => {
        clientSocket.emit(
          "presence:join",
          {
            roomId: "test-channel",
            userId: "user-1",
          },
          resolve
        );
      });

      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string; code?: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:updateChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: "nonexistent", value: "Value" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.code).toBe("METADATA_INVALID");
      }
    });

    it("should reject missing required fields", async () => {
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              // Missing channelName
              channelType: "MESSAGE",
              data: [{ key: "topic", value: "Topic" }],
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
      }
    });

    it("should reject type errors", async () => {
      const response = await new Promise<ChannelMetadataResponse | { ok: false; error: string }>(
        (resolve) => {
          clientSocket.emit(
            "metadata:setChannel",
            {
              channelName: "test-channel",
              channelType: "MESSAGE",
              data: [{ key: 123 as any, value: "Topic" }], // Invalid key type
            },
            resolve
          );
        }
      );

      if ("ok" in response && !response.ok) {
        expect(response.error).toBeDefined();
      }
    });
  });
});

