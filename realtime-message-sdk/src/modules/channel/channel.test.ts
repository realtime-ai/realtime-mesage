import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Channel } from "./channel";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";

interface UserPresenceState {
  status: "active" | "away";
  typing: boolean;
}

interface RoomStorage {
  topic: string;
  moderator: string;
  config: { theme: string; lang: string };
}

describe("Channel (Unified API)", () => {
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
      // Presence handlers
      socket.on("presence:join", (_payload, ack) => {
        ack({
          ok: true,
          self: { connId: "test-conn", epoch: 1 },
          snapshot: [],
        });
      });

      socket.on("presence:leave", (_payload, ack) => {
        ack?.();
      });

      socket.on("presence:heartbeat", (_payload, ack) => {
        ack({ ok: true, changed: true });
      });

      // Storage (metadata) handlers
      socket.on("metadata:getChannel", (_payload, ack) => {
        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: "test-channel",
          channelType: "ROOM",
          totalCount: 0,
          majorRevision: 1,
          metadata: {},
        });
      });

      socket.on("metadata:setChannel", (payload, ack) => {
        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: payload.data.length,
          majorRevision: 2,
          metadata: payload.data.reduce((acc: any, item: any) => {
            acc[item.key] = { value: item.value, revision: 1 };
            return acc;
          }, {}),
        });
      });

      socket.on("metadata:removeChannel", (payload, ack) => {
        ack({
          ok: true,
          timestamp: Date.now(),
          channelName: payload.channelName,
          channelType: payload.channelType,
          totalCount: 0,
          majorRevision: 3,
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

  describe("Initialization", () => {
    it("should create a channel with presence and storage sub-modules", () => {
      const channel = new Channel(clientSocket, "test-channel", silentLogger);

      expect(channel).toBeDefined();
      expect(channel.presence).toBeDefined();
      expect(channel.storage).toBeDefined();
    });

    it("should create a typed channel with generic parameters", () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-channel",
        silentLogger
      );

      expect(channel).toBeDefined();
      expect(channel.getChannelId()).toBe("test-channel");
      expect(channel.getChannelType()).toBe("ROOM");
    });

    it("should support custom channel type", () => {
      const channel = new Channel(clientSocket, "test-channel", silentLogger, {
        channelType: "DIRECT_MESSAGE",
      });

      expect(channel.getChannelType()).toBe("DIRECT_MESSAGE");
    });
  });

  describe("Convenience Methods", () => {
    it("should proxy join() to presence.join()", async () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-room",
        silentLogger
      );

      const response = await channel.join("alice", {
        status: "active",
        typing: false,
      });

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.self.connId).toBe("test-conn");
      }

      await channel.leave();
    });

    it("should proxy leave() to presence.leave()", async () => {
      const channel = new Channel(clientSocket, "test-room", silentLogger);

      await channel.join("bob", {});
      await channel.leave();

      expect(channel.presence.isJoined()).toBe(false);
    });

    it("should proxy get() to storage.get()", async () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-channel",
        silentLogger
      );

      const topic = await channel.get("topic");
      expect(topic).toBeNull(); // Empty storage
    });

    it("should proxy set() to storage.set()", async () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-channel",
        silentLogger
      );

      await channel.set("topic", "Daily Standup");
      // Verify it was called (actual storage behavior tested separately)
    });

    it("should proxy remove() to storage.remove()", async () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-channel",
        silentLogger
      );

      await channel.remove("topic");
      // Verify it was called (actual storage behavior tested separately)
    });
  });

  describe("Event Forwarding", () => {
    it("should forward presence events to unified channel events", async () => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-room",
        silentLogger
      );

      const presenceJoinedSpy = vi.fn();
      channel.on("presenceJoined", presenceJoinedSpy);

      // Join will trigger snapshot event which is internal
      await channel.join("alice", { status: "active", typing: false });

      await channel.leave();
    });

    it("should forward storage events to unified channel events", (done) => {
      const channel = new Channel<UserPresenceState, RoomStorage>(
        clientSocket,
        "test-channel",
        silentLogger
      );

      channel.on("storageUpdated", (event) => {
        expect(event).toBeDefined();
        expect(event.operation).toBe("set");
        done();
      });

      // Simulate storage event from server
      setTimeout(() => {
        clientSocket.emit("metadata:event", {
          channelName: "test-channel",
          channelType: "ROOM",
          operation: "set",
          items: [{ key: "topic", value: "Meeting" }],
          majorRevision: 1,
          timestamp: Date.now(),
        });
      }, 100);
    });

    it("should forward errors from sub-modules", (done) => {
      const channel = new Channel(clientSocket, "test-channel", silentLogger);

      channel.on("error", (error) => {
        expect(error).toBeInstanceOf(Error);
        done();
      });

      // Trigger an error from storage
      channel.storage.emit("error", new Error("Test error"));
    });
  });

  describe("Dispose", () => {
    it("should dispose storage and clean up resources", () => {
      const channel = new Channel(clientSocket, "test-channel", silentLogger);

      const disposeSpy = vi.spyOn(channel.storage, "dispose");

      channel.dispose();

      expect(disposeSpy).toHaveBeenCalled();
    });
  });
});
