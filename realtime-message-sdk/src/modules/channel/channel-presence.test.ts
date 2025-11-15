import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { ChannelPresence } from "./channel-presence";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";

interface UserPresenceState {
  status: "active" | "away" | "offline";
  typing: boolean;
  lastActivity?: number;
}

describe("ChannelPresence", () => {
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
      socket.on("presence:join", (_payload, ack) => {
        ack({
          ok: true,
          self: { connId: "test-conn", epoch: 1 },
          snapshot: [
            {
              connId: "conn-1",
              userId: "alice",
              state: { status: "active", typing: false },
              lastSeenMs: Date.now(),
              epoch: 1,
            },
          ],
        });
      });

      socket.on("presence:leave", (_payload, ack) => {
        ack?.();
      });

      socket.on("presence:heartbeat", (payload, ack) => {
        ack({ ok: true, changed: !!payload.patchState, epoch: 2 });
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

  describe("Join", () => {
    it("should join a channel with userId and state", async () => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-1",
        silentLogger
      );

      const response = await presence.join("alice", {
        status: "active",
        typing: false,
      });

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.self.connId).toBe("test-conn");
        expect(response.self.epoch).toBe(1);
        expect(response.snapshot).toHaveLength(1);
      }

      expect(presence.isJoined()).toBe(true);
      expect(presence.getUserId()).toBe("alice");

      await presence.leave();
    });

    it("should join without state", async () => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-2",
        silentLogger
      );

      const response = await presence.join("bob");

      expect(response.ok).toBe(true);
      expect(presence.isJoined()).toBe(true);

      await presence.leave();
    });

    it("should leave previous channel if joining while already joined", async () => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-3",
        silentLogger
      );

      await presence.join("alice", { status: "active", typing: false });
      expect(presence.isJoined()).toBe(true);

      // Join again should leave first
      await presence.join("alice", { status: "active", typing: false });
      expect(presence.isJoined()).toBe(true);

      await presence.leave();
    });
  });

  describe("Update State", () => {
    it("should update presence state", async () => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-4",
        silentLogger
      );

      await presence.join("alice", { status: "active", typing: false });

      const response = await presence.updateState({ typing: true });

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.changed).toBe(true);
        expect(response.epoch).toBe(2);
      }

      await presence.leave();
    });

    it("should throw error when updating state before join", async () => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-5",
        silentLogger
      );

      await expect(
        presence.updateState({ typing: true })
      ).rejects.toThrow("Cannot update state before joining");
    });
  });

  describe("Leave", () => {
    it("should leave the channel", async () => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-6",
        silentLogger
      );

      await presence.join("alice");
      expect(presence.isJoined()).toBe(true);

      await presence.leave();
      expect(presence.isJoined()).toBe(false);
      expect(presence.getUserId()).toBeNull();
    });

    it("should handle leave when not joined", async () => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-7",
        silentLogger
      );

      await presence.leave();
      expect(presence.isJoined()).toBe(false);
    });

    it("should support stop() as alias for leave()", async () => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-8",
        silentLogger
      );

      await presence.join("alice");
      await presence.stop();

      expect(presence.isJoined()).toBe(false);
    });
  });

  describe("Event Forwarding", () => {
    it("should emit joined event on presence:event with type join", (done) => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-9",
        silentLogger
      );

      presence.join("alice", { status: "active", typing: false }).then(() => {
        presence.on("joined", (event) => {
          expect(event.type).toBe("join");
          expect(event.userId).toBe("bob");
          presence.leave().then(() => done());
        });

        // Simulate another user joining
        setTimeout(() => {
          clientSocket.emit("presence:event", {
            type: "join",
            roomId: "room-9",
            userId: "bob",
            connId: "conn-2",
            state: { status: "active", typing: false },
            ts: Date.now(),
            epoch: 1,
          });
        }, 100);
      });
    });

    it("should emit left event on presence:event with type leave", (done) => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-10",
        silentLogger
      );

      presence.join("alice").then(() => {
        presence.on("left", (event) => {
          expect(event.type).toBe("leave");
          expect(event.userId).toBe("bob");
          presence.leave().then(() => done());
        });

        // Simulate another user leaving
        setTimeout(() => {
          clientSocket.emit("presence:event", {
            type: "leave",
            roomId: "room-10",
            userId: "bob",
            connId: "conn-2",
            ts: Date.now(),
          });
        }, 100);
      });
    });

    it("should emit updated event on presence:event with type update", (done) => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-11",
        silentLogger
      );

      presence.join("alice", { status: "active", typing: false }).then(() => {
        presence.on("updated", (event) => {
          expect(event.type).toBe("update");
          expect(event.userId).toBe("alice");
          presence.leave().then(() => done());
        });

        // Simulate state update
        setTimeout(() => {
          clientSocket.emit("presence:event", {
            type: "update",
            roomId: "room-11",
            userId: "alice",
            connId: "test-conn",
            state: { status: "active", typing: true },
            ts: Date.now(),
            epoch: 2,
          });
        }, 100);
      });
    });

    it("should emit snapshot event on join", (done) => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-12",
        silentLogger
      );

      presence.on("snapshot", (snapshot) => {
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].userId).toBe("alice");
        presence.leave().then(() => done());
      });

      presence.join("bob", { status: "active", typing: false });
    });

    it("should emit error events", (done) => {
      const presence = new ChannelPresence(
        clientSocket,
        "room-13",
        silentLogger
      );

      presence.join("alice").then(() => {
        presence.on("error", (error) => {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe("Test error");
          presence.leave().then(() => done());
        });

        // Simulate error from underlying presence channel
        // This would typically come from heartbeat failures, etc.
        setTimeout(() => {
          // Manually trigger error through the internal channel
          const internalChannel = (presence as any).presenceChannel;
          if (internalChannel) {
            internalChannel.emit("error", new Error("Test error"));
          }
        }, 100);
      });
    });
  });

  describe("Get Members", () => {
    it("should warn that getMembers is not yet implemented", async () => {
      const presence = new ChannelPresence<UserPresenceState>(
        clientSocket,
        "room-14",
        silentLogger
      );

      await presence.join("alice", { status: "active", typing: false });

      const members = await presence.getMembers();
      expect(members).toEqual([]);
      expect(silentLogger.warn).toHaveBeenCalledWith(
        "getMembers is not yet fully implemented"
      );

      await presence.leave();
    });
  });
});
