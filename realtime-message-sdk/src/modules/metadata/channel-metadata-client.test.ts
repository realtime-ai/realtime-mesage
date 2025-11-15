import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ChannelMetadataClient, MetadataConflictError, MetadataLockError, MetadataValidationError, MetadataError } from "./channel-metadata-client";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import type { Socket as ServerSocket } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";
import type {
  ChannelMetadataResponse,
  ChannelMetadataItem,
  ChannelMetadataEvent,
} from "./types";

describe("ChannelMetadataClient", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let port: number;
  let clientSocket: ClientSocket;
  let metadataClient: ChannelMetadataClient;

  const getActiveServerSocket = (): ServerSocket | null => {
    const namespace = io?.of?.("/");
    if (!namespace) {
      return null;
    }
    for (const socket of namespace.sockets.values()) {
      return socket;
    }
    return null;
  };

  const withServerSocket = (handler: (socket: ServerSocket) => void): void => {
    const socket = getActiveServerSocket();
    if (!socket) {
      throw new Error("Test socket is not connected");
    }
    handler(socket);
  };

  const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

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

  beforeAll(async () => {
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

    metadataClient = new ChannelMetadataClient(clientSocket, silentLogger);
  });

  beforeEach(() => {
    io.removeAllListeners("connection");
    getActiveServerSocket()?.removeAllListeners();
  });

  afterAll(async () => {
    metadataClient?.dispose();
    clientSocket?.disconnect();
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
  });

  describe("Basic CRUD Operations", () => {
    describe("setChannelMetadata", () => {
      it("should successfully set a single metadata item", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 1,
          majorRevision: 1,
          metadata: {
            topic: {
              value: "Daily Standup",
              revision: 1,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:setChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Daily Standup" }],
        options: {},
      });

        expect(response.channelName).toBe("test-channel");
        expect(response.channelType).toBe("MESSAGE");
        expect(response.totalCount).toBe(1);
        expect(response.majorRevision).toBe(1);
        expect(response.metadata.topic?.value).toBe("Daily Standup");
        expect(response.metadata.topic?.revision).toBe(1);
      });

      it("should successfully set multiple metadata items", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 2,
          majorRevision: 1,
          metadata: {
            topic: {
              value: "Daily Standup",
              revision: 1,
            },
            moderator: {
              value: "alice",
              revision: 1,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:setChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Daily Standup" },
            { key: "moderator", value: "alice" },
          ],
          options: {},
        });

        expect(response.totalCount).toBe(2);
        expect(Object.keys(response.metadata)).toHaveLength(2);
        expect(response.metadata.topic?.value).toBe("Daily Standup");
        expect(response.metadata.moderator?.value).toBe("alice");
      });

      it("should validate response structure", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: 1234567890,
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 1,
          majorRevision: 5,
          metadata: {
            key1: {
              value: "value1",
              revision: 3,
              updated: "2024-01-01T00:00:00.000Z",
              authorUid: "user-123",
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:setChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "key1", value: "value1" }],
          options: {},
        });

        expect(response).toHaveProperty("timestamp");
        expect(response).toHaveProperty("channelName");
        expect(response).toHaveProperty("channelType");
        expect(response).toHaveProperty("totalCount");
        expect(response).toHaveProperty("majorRevision");
        expect(response).toHaveProperty("metadata");
        expect(response.timestamp).toBe(1234567890);
        expect(response.majorRevision).toBe(5);
      });
    });

    describe("getChannelMetadata", () => {
      it("should get existing metadata", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 2,
          majorRevision: 3,
          metadata: {
            topic: {
              value: "Meeting",
              revision: 2,
            },
            status: {
              value: "active",
              revision: 1,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:getChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        });

        expect(response.totalCount).toBe(2);
        expect(response.majorRevision).toBe(3);
        expect(response.metadata.topic?.value).toBe("Meeting");
        expect(response.metadata.status?.value).toBe("active");
      });

      it("should return empty metadata for non-existent channel", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "non-existent",
          channelType: "MESSAGE",
          totalCount: 0,
          majorRevision: 0,
          metadata: {},
        };

        withServerSocket((socket) => {
          socket.on("metadata:getChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.getChannelMetadata({
          channelName: "non-existent",
          channelType: "MESSAGE",
        });

        expect(response.totalCount).toBe(0);
        expect(Object.keys(response.metadata)).toHaveLength(0);
      });
    });

    describe("updateChannelMetadata", () => {
      it("should update existing metadata item", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 1,
          majorRevision: 2,
          metadata: {
            topic: {
              value: "Updated Topic",
              revision: 2,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:updateChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated Topic" }],
          options: {},
        });

        expect(response.metadata.topic?.value).toBe("Updated Topic");
        expect(response.metadata.topic?.revision).toBe(2);
        expect(response.majorRevision).toBe(2);
      });

      it("should update multiple metadata items", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 2,
          majorRevision: 3,
          metadata: {
            topic: {
              value: "New Topic",
              revision: 2,
            },
            moderator: {
              value: "bob",
              revision: 2,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:updateChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "New Topic" },
            { key: "moderator", value: "bob" },
          ],
          options: {},
        });

        expect(response.totalCount).toBe(2);
        expect(response.metadata.topic?.revision).toBe(2);
        expect(response.metadata.moderator?.revision).toBe(2);
      });

      it("should throw MetadataValidationError when updating non-existent item", async () => {
        withServerSocket((socket) => {
          socket.on("metadata:updateChannel", (_payload, ack) => {
            ack({
              ok: false,
              error: "Metadata item \"nonexistent\" does not exist",
              code: "METADATA_INVALID",
            });
          });
        });

        await expect(
          metadataClient.updateChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "nonexistent", value: "value" }],
            options: {},
          })
        ).rejects.toThrow(MetadataValidationError);
      });
    });

    describe("removeChannelMetadata", () => {
      it("should remove specified metadata items", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 1,
          majorRevision: 2,
          metadata: {
            topic: {
              value: "Meeting",
              revision: 1,
            },
          },
        };

        withServerSocket((socket) => {
          socket.on("metadata:removeChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.removeChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "moderator" }],
          options: {},
        });

        expect(response.totalCount).toBe(1);
        expect(response.metadata.moderator).toBeUndefined();
      });

      it("should remove all metadata when data is not provided", async () => {
        const mockResponse: ChannelMetadataResponse = {
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "MESSAGE",
          totalCount: 0,
          majorRevision: 2,
          metadata: {},
        };

        withServerSocket((socket) => {
          socket.on("metadata:removeChannel", (_payload, ack) => {
            ack({ ok: true, data: mockResponse });
          });
        });

        const response = await metadataClient.removeChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          options: {},
        });

        expect(response.totalCount).toBe(0);
        expect(Object.keys(response.metadata)).toHaveLength(0);
      });
    });
  });

  describe("Ack Compatibility", () => {
    it("should support inline metadata payloads without data wrapper", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 3,
        metadata: {
          topic: {
            value: "Inline",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, ...mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Inline" }],
      });

      expect(response.ok).toBeUndefined();
      expect(response.channelName).toBe("test-channel");
      expect(response.metadata.topic?.value).toBe("Inline");
    });
  });

  describe("Version Control (CAS)", () => {
    it("should succeed with correct majorRevision", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 2,
        metadata: {
          topic: {
            value: "Updated",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        options: { majorRevision: 1 },
      });

      expect(response.majorRevision).toBe(2);
    });

    it("should throw MetadataConflictError with incorrect majorRevision", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Expected major revision 1, but got 5",
            code: "METADATA_CONFLICT",
          });
        });
      });

      await expect(
        metadataClient.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated" }],
          options: { majorRevision: 1 },
        })
      ).rejects.toThrow(MetadataConflictError);
    });

    it("should skip validation when majorRevision is -1", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 10,
        metadata: {
          topic: {
            value: "Updated",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        options: { majorRevision: -1 },
      });

      expect(response.majorRevision).toBe(10);
    });

    it("should succeed with correct item revision", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 2,
        metadata: {
          topic: {
            value: "Updated",
            revision: 2,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated", revision: 1 }],
        options: {},
      });

      expect(response.metadata.topic?.revision).toBe(2);
    });

    it("should throw MetadataConflictError with incorrect item revision", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Revision mismatch for key \"topic\"",
            code: "METADATA_CONFLICT",
          });
        });
      });

        await expect(
          metadataClient.updateChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Updated", revision: 0 }],
            options: {},
          })
        ).rejects.toThrow(MetadataConflictError);
    });

    it("should skip validation when item revision is -1", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 2,
        metadata: {
          topic: {
            value: "Updated",
            revision: 5,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated", revision: -1 }],
        options: {},
      });

      expect(response.metadata.topic?.revision).toBe(5);
    });
  });

  describe("Lock Mechanism", () => {
    it("should succeed when lock is held by the user", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Locked Update",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Locked Update" }],
        options: { lockName: "test-lock" },
      });

      expect(response.metadata.topic?.value).toBe("Locked Update");
    });

    it("should throw MetadataLockError when lock is not held", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Lock \"test-lock\" is held by another user",
            code: "METADATA_LOCK",
          });
        });
      });

      await expect(
        metadataClient.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Value" }],
          options: { lockName: "test-lock" },
        })
      ).rejects.toThrow(MetadataLockError);
    });

    it("should throw MetadataLockError when lock does not exist", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Lock \"nonexistent-lock\" is not held",
            code: "METADATA_LOCK",
          });
        });
      });

      await expect(
        metadataClient.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Value" }],
          options: { lockName: "nonexistent-lock" },
        })
      ).rejects.toThrow(MetadataLockError);
    });

    it("should work normally when lockName is not provided", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Normal Update",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Normal Update" }],
        options: {},
      });

      expect(response.metadata.topic?.value).toBe("Normal Update");
    });
  });

  describe("Audit Fields", () => {
    it("should include updated timestamp when addTimestamp is true", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Topic",
            revision: 1,
            updated: "2024-01-01T00:00:00.000Z",
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: { addTimestamp: true },
      });

      expect(response.metadata.topic?.updated).toBe("2024-01-01T00:00:00.000Z");
    });

    it("should not include updated timestamp when addTimestamp is false", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Topic",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: { addTimestamp: false },
      });

      expect(response.metadata.topic?.updated).toBeUndefined();
    });

    it("should include authorUid when addUserId is true", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Topic",
            revision: 1,
            authorUid: "user-123",
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: { addUserId: true },
      });

      expect(response.metadata.topic?.authorUid).toBe("user-123");
    });

    it("should not include authorUid when addUserId is false", async () => {
      const mockResponse: ChannelMetadataResponse = {
        timestamp: Date.now(),
        channelName: "test-channel",
        channelType: "MESSAGE",
        totalCount: 1,
        majorRevision: 1,
        metadata: {
          topic: {
            value: "Topic",
            revision: 1,
          },
        },
      };

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: true, data: mockResponse });
        });
      });

      const response = await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: { addUserId: false },
      });

      expect(response.metadata.topic?.authorUid).toBeUndefined();
    });
  });

  describe("Event Listening", () => {
    it("should receive set operation events", async () => {
      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({
            ok: true,
            data: {
              timestamp: Date.now(),
              channelName: "test-channel",
              channelType: "MESSAGE",
              totalCount: 1,
              majorRevision: 1,
              metadata: {
                topic: {
                  value: "Topic",
                  revision: 1,
                },
              },
            },
          });
        });
      });

      await metadataClient.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: {},
      });

      // Simulate server sending event
      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [{ key: "topic", value: "Topic" }],
        majorRevision: 1,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      await waitFor(() => events.length > 0);

      expect(events).toHaveLength(1);
      expect(events[0].operation).toBe("set");
      expect(events[0].channelName).toBe("test-channel");
      expect(events[0].items).toHaveLength(1);

      unsubscribe();
    });

    it("should receive update operation events", async () => {
      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "update",
        items: [{ key: "topic", value: "Updated" }],
        majorRevision: 2,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      await waitFor(() => events.length > 0);

      expect(events[0].operation).toBe("update");
      expect(events[0].majorRevision).toBe(2);

      unsubscribe();
    });

    it("should receive remove operation events", async () => {
      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "remove",
        items: [{ key: "topic" }],
        majorRevision: 3,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      await waitFor(() => events.length > 0);

      expect(events[0].operation).toBe("remove");
      expect(events[0].items[0].key).toBe("topic");

      unsubscribe();
    });

    it("should validate event payload structure", async () => {
      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [
          { key: "topic", value: "Topic", revision: 1 },
          { key: "moderator", value: "alice" },
        ],
        majorRevision: 1,
        timestamp: 1234567890,
        authorUid: "user-123",
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      await waitFor(() => events.length > 0);

      const event = events[0];
      expect(event).toHaveProperty("channelName");
      expect(event).toHaveProperty("channelType");
      expect(event).toHaveProperty("operation");
      expect(event).toHaveProperty("items");
      expect(event).toHaveProperty("majorRevision");
      expect(event).toHaveProperty("timestamp");
      expect(event.items).toHaveLength(2);
      expect(event.authorUid).toBe("user-123");

      unsubscribe();
    });

    it("should support multiple event listeners", async () => {
      const events1: ChannelMetadataEvent[] = [];
      const events2: ChannelMetadataEvent[] = [];

      const unsubscribe1 = metadataClient.onChannelEvent((event) => {
        events1.push(event);
      });

      const unsubscribe2 = metadataClient.onChannelEvent((event) => {
        events2.push(event);
      });

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [{ key: "topic", value: "Topic" }],
        majorRevision: 1,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      await waitFor(() => events1.length > 0 && events2.length > 0);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      unsubscribe1();
      unsubscribe2();
    });

    it("should allow unsubscribing from events", async () => {
      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [{ key: "topic", value: "Topic" }],
        majorRevision: 1,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });
      await waitFor(() => events.length > 0);

      expect(events).toHaveLength(1);

      unsubscribe();

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(events).toHaveLength(1); // Should not increase
    });
  });

  describe("Error Handling", () => {
    it("should map METADATA_CONFLICT to MetadataConflictError", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Version conflict",
            code: "METADATA_CONFLICT",
          });
        });
      });

        await expect(
          metadataClient.updateChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Updated" }],
            options: {},
          })
        ).rejects.toThrow(MetadataConflictError);
    });

    it("should map METADATA_LOCK to MetadataLockError", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Lock error",
            code: "METADATA_LOCK",
          });
        });
      });

        await expect(
          metadataClient.setChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Value" }],
            options: {},
          })
        ).rejects.toThrow(MetadataLockError);
    });

    it("should map METADATA_INVALID to MetadataValidationError", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:updateChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Validation error",
            code: "METADATA_INVALID",
          });
        });
      });

        await expect(
          metadataClient.updateChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "topic", value: "Updated" }],
            options: {},
          })
        ).rejects.toThrow(MetadataValidationError);
    });

    it("should map unknown errors to MetadataError", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:getChannel", (_payload, ack) => {
          ack({
            ok: false,
            error: "Unknown error",
            code: "UNKNOWN_ERROR",
          });
        });
      });

      await expect(
        metadataClient.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        })
      ).rejects.toThrow(MetadataError);
    });

    it("should handle malformed acknowledgement", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:getChannel", (_payload, ack) => {
          ack(null as any);
        });
      });

      await expect(
        metadataClient.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        })
      ).rejects.toThrow(MetadataError);
    });

    it("should handle socket errors", async () => {
      withServerSocket((socket) => {
        socket.on("metadata:getChannel", () => {
          socket.emit("error", new Error("Socket error"));
        });
      });

      await expect(
        metadataClient.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        })
      ).rejects.toThrow();
    });
  });

  describe("Lifecycle", () => {
    it("should remove event listeners on dispose", async () => {
      const events: ChannelMetadataEvent[] = [];

      metadataClient.onChannelEvent((event) => {
        events.push(event);
      });

      metadataClient.dispose();

      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [{ key: "topic", value: "Topic" }],
        majorRevision: 1,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(events).toHaveLength(0);
    });

    it("should clear all handlers on dispose", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      metadataClient.onChannelEvent(handler1);
      metadataClient.onChannelEvent(handler2);

      metadataClient.dispose();

      // Create new client to test that dispose worked
      const newClient = new ChannelMetadataClient(clientSocket, silentLogger);
      const mockEvent: ChannelMetadataEvent = {
        channelName: "test-channel",
        channelType: "MESSAGE",
        operation: "set",
        items: [{ key: "topic", value: "Topic" }],
        majorRevision: 1,
        timestamp: Date.now(),
      };

      withServerSocket((socket) => {
        socket.emit("metadata:event", mockEvent);
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();

      newClient.dispose();
    });
  });
});
