import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  ChannelStorage,
  StorageError,
  StorageConflictError,
  StorageLockError,
  StorageValidationError,
} from "./channel-storage";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";

interface RoomStorage {
  topic: string;
  moderator: string;
  pinned: boolean;
  config: { theme: string; lang: string };
}

describe("ChannelStorage", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let port: number;
  let clientSocket: ClientSocket;

  const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // In-memory storage for testing
  let mockStorage: Record<string, any> = {};
  let majorRevision = 0;

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
        port = (addr as AddressInfo).port;
        resolve();
      });
    });

    // Setup mock handlers
    io.on("connection", (socket) => {
      socket.on("metadata:getChannel", (payload, ack) => {
        const metadata = Object.entries(mockStorage).reduce((acc, [key, value]) => {
          acc[key] = {
            value: typeof value === "string" ? value : JSON.stringify(value),
            revision: 1,
          };
          return acc;
        }, {} as any);

        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: Object.keys(mockStorage).length,
          majorRevision,
          metadata,
        });
      });

      socket.on("metadata:setChannel", (payload, ack) => {
        payload.data.forEach((item: any) => {
          mockStorage[item.key] = item.value;
        });
        majorRevision++;

        const metadata = payload.data.reduce((acc: any, item: any) => {
          acc[item.key] = { value: item.value, revision: 1 };
          return acc;
        }, {});

        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: payload.data.length,
          majorRevision,
          metadata,
        });
      });

      socket.on("metadata:updateChannel", (payload, ack) => {
        payload.data.forEach((item: any) => {
          mockStorage[item.key] = item.value;
        });
        majorRevision++;

        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: Object.keys(mockStorage).length,
          majorRevision,
          metadata: {},
        });
      });

      socket.on("metadata:removeChannel", (payload, ack) => {
        if (payload.data) {
          payload.data.forEach((item: any) => {
            delete mockStorage[item.key];
          });
        } else {
          mockStorage = {};
        }
        majorRevision++;

        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: 0,
          majorRevision,
          metadata: {},
        });
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
  });

  afterAll(async () => {
    clientSocket?.disconnect();
    io?.close();
    httpServer?.close();
  });

  describe("Single-Item Operations", () => {
    beforeEach(() => {
      mockStorage = {};
      majorRevision = 0;
    });

    it("should get a single storage value", async () => {
      mockStorage = { topic: '"Daily Standup"' };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-1",
        "ROOM",
        silentLogger
      );

      const topic = await storage.get("topic");
      expect(topic).toBe("Daily Standup");

      storage.dispose();
    });

    it("should return null for non-existent key", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-2",
        "ROOM",
        silentLogger
      );

      const value = await storage.get("topic");
      expect(value).toBeNull();

      storage.dispose();
    });

    it("should set a single storage value", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-3",
        "ROOM",
        silentLogger
      );

      await storage.set("topic", "Team Meeting");

      expect(mockStorage.topic).toBe('"Team Meeting"');

      storage.dispose();
    });

    it("should handle setting primitive values", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-4",
        "ROOM",
        silentLogger
      );

      await storage.set("pinned", true);

      expect(mockStorage.pinned).toBe("true");

      storage.dispose();
    });

    it("should handle setting object values", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-5",
        "ROOM",
        silentLogger
      );

      await storage.set("config", { theme: "dark", lang: "en" });

      expect(JSON.parse(mockStorage.config)).toEqual({ theme: "dark", lang: "en" });

      storage.dispose();
    });

    it("should remove a single storage key", async () => {
      mockStorage = { topic: '"Meeting"', moderator: '"alice"' };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-6",
        "ROOM",
        silentLogger
      );

      await storage.remove("topic");

      expect(mockStorage.topic).toBeUndefined();

      storage.dispose();
    });
  });

  describe("Batch Operations", () => {
    beforeEach(() => {
      mockStorage = {};
      majorRevision = 0;
    });

    it("should get all storage data", async () => {
      mockStorage = {
        topic: '"Daily Standup"',
        moderator: '"alice"',
      };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-7",
        "ROOM",
        silentLogger
      );

      const response = await storage.getAll();

      expect(response.totalCount).toBe(2);
      expect(response.metadata.topic).toBeDefined();
      expect(response.metadata.moderator).toBeDefined();

      storage.dispose();
    });

    it("should set multiple values", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-8",
        "ROOM",
        silentLogger
      );

      await storage.setMany({
        topic: "Team Meeting",
        moderator: "bob",
        pinned: true,
      });

      expect(mockStorage.topic).toBeDefined();
      expect(mockStorage.moderator).toBeDefined();
      expect(mockStorage.pinned).toBeDefined();

      storage.dispose();
    });

    it("should update multiple values", async () => {
      mockStorage = { topic: '"Old Topic"' };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-9",
        "ROOM",
        silentLogger
      );

      await storage.updateMany({
        topic: "New Topic",
        moderator: "charlie",
      });

      expect(mockStorage.topic).toBe('"New Topic"');
      expect(mockStorage.moderator).toBe('"charlie"');

      storage.dispose();
    });

    it("should remove multiple keys", async () => {
      mockStorage = {
        topic: '"Meeting"',
        moderator: '"alice"',
        pinned: "true",
      };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-10",
        "ROOM",
        silentLogger
      );

      await storage.removeMany(["topic", "moderator"]);

      expect(mockStorage.topic).toBeUndefined();
      expect(mockStorage.moderator).toBeUndefined();
      expect(mockStorage.pinned).toBeDefined();

      storage.dispose();
    });

    it("should clear all storage data", async () => {
      mockStorage = {
        topic: '"Meeting"',
        moderator: '"alice"',
        pinned: "true",
      };

      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-11",
        "ROOM",
        silentLogger
      );

      await storage.clear();

      expect(Object.keys(mockStorage)).toHaveLength(0);

      storage.dispose();
    });
  });

  describe("Storage Options", () => {
    beforeEach(() => {
      mockStorage = {};
      majorRevision = 0;
    });

    it("should pass options to set operation", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-12",
        "ROOM",
        silentLogger
      );

      await storage.set("topic", "Meeting", {
        addTimestamp: true,
        addUserId: true,
      });

      expect(mockStorage.topic).toBeDefined();

      storage.dispose();
    });

    it("should pass options to setMany operation", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-13",
        "ROOM",
        silentLogger
      );

      await storage.setMany(
        { topic: "Meeting", moderator: "alice" },
        { majorRevision: 1 }
      );

      expect(mockStorage.topic).toBeDefined();

      storage.dispose();
    });
  });

  describe("Event Handling", () => {
    beforeEach(() => {
      mockStorage = {};
      majorRevision = 0;
    });

    it("should emit updated event on storage updates", (done) => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-14",
        "ROOM",
        silentLogger
      );

      storage.on("updated", (event) => {
        expect(event.operation).toBe("set");
        expect(event.channelName).toBe("room-14");
        storage.dispose();
        done();
      });

      // Simulate storage event from server
      setTimeout(() => {
        clientSocket.emit("metadata:event", {
          channelName: "room-14",
          channelType: "ROOM",
          operation: "set",
          items: [{ key: "topic", value: "Meeting" }],
          majorRevision: 1,
          timestamp: Date.now(),
        });
      }, 100);
    });

    it("should emit removed event on storage removals", (done) => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-15",
        "ROOM",
        silentLogger
      );

      storage.on("removed", (event) => {
        expect(event.operation).toBe("remove");
        expect(event.channelName).toBe("room-15");
        storage.dispose();
        done();
      });

      // Simulate storage event from server
      setTimeout(() => {
        clientSocket.emit("metadata:event", {
          channelName: "room-15",
          channelType: "ROOM",
          operation: "remove",
          items: [{ key: "topic" }],
          majorRevision: 2,
          timestamp: Date.now(),
        });
      }, 100);
    });

    it("should only handle events for its own channel", (done) => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-16",
        "ROOM",
        silentLogger
      );

      const updatedSpy = vi.fn();
      storage.on("updated", updatedSpy);

      // Emit event for different channel
      clientSocket.emit("metadata:event", {
        channelName: "room-17", // Different channel
        channelType: "ROOM",
        operation: "set",
        items: [{ key: "topic", value: "Meeting" }],
        majorRevision: 1,
        timestamp: Date.now(),
      });

      setTimeout(() => {
        expect(updatedSpy).not.toHaveBeenCalled();
        storage.dispose();
        done();
      }, 200);
    });
  });

  describe("Error Handling", () => {
    it("should map error codes correctly", async () => {
      // Create a temporary server that returns errors
      const errorServer = createServer();
      const errorIo = new SocketIOServer(errorServer);

      await new Promise<void>((resolve) => {
        errorServer.listen(0, () => resolve());
      });

      const errorPort = (errorServer.address() as AddressInfo).port;

      errorIo.on("connection", (socket) => {
        socket.on("metadata:setChannel", (_payload, ack) => {
          ack({ ok: false, error: "Version conflict", code: "METADATA_CONFLICT" });
        });
      });

      const errorClient = ioClient(`http://localhost:${errorPort}`, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });

      await new Promise<void>((resolve, reject) => {
        errorClient.once("connect", () => resolve());
        errorClient.once("connect_error", (error) => reject(error));
      });

      const storage = new ChannelStorage(
        errorClient,
        "room-error",
        "ROOM",
        silentLogger
      );

      await expect(storage.set("topic", "Test")).rejects.toThrow(
        StorageConflictError
      );

      storage.dispose();
      errorClient.disconnect();
      errorIo.close();
      errorServer.close();
    });
  });

  describe("Dispose", () => {
    it("should detach listeners and remove all event handlers", () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-18",
        "ROOM",
        silentLogger
      );

      const handler = vi.fn();
      storage.on("updated", handler);

      storage.dispose();

      // Emit event after dispose
      clientSocket.emit("metadata:event", {
        channelName: "room-18",
        channelType: "ROOM",
        operation: "set",
        items: [{ key: "topic", value: "Meeting" }],
        majorRevision: 1,
        timestamp: Date.now(),
      });

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("Lock Support", () => {
    beforeEach(() => {
      mockStorage = {};
      majorRevision = 0;
    });

    it("should execute callback in withLock (experimental)", async () => {
      const storage = new ChannelStorage<RoomStorage>(
        clientSocket,
        "room-19",
        "ROOM",
        silentLogger
      );

      const result = await storage.withLock(async (s) => {
        await s.set("topic", "Locked Meeting");
        return "success";
      });

      expect(result).toBe("success");
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("withLock is not yet fully implemented")
      );

      storage.dispose();
    });
  });
});
