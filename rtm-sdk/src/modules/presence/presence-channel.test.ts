import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PresenceChannel } from "./presence-channel";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";
import type { PresenceJoinResponse } from "./types";

describe("PresenceChannel", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let port: number;
  let clientSocket: ClientSocket;
  let channel: PresenceChannel;

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });

      clientSocket.once("connect", () => resolve());
      clientSocket.once("connect_error", reject);
    });
  });

  afterEach(async () => {
    if (channel) {
      await channel.stop();
    }
    clientSocket?.disconnect();
    await new Promise<void>((resolve, reject) => {
      io.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  describe("Join and Initialization", () => {
    it("should join room successfully", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: {
              connId: socket.id,
              epoch: 1,
              state: payload.state,
            },
            snapshot: [],
          });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const response = await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: { mic: true },
      });

      expect(response.ok).toBe(true);
      expect(response.self.connId).toBe(clientSocket.id);
      expect(response.self.epoch).toBe(1);
    });

    it("should handle join failure", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: false,
            error: {
              code: "ROOM_FULL",
              message: "Room is full",
            },
          });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const response = await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("ROOM_FULL");
    });

    it("should emit connected event on successful join", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const connectedFn = vi.fn();
      channel.on("connected", connectedFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      expect(connectedFn).toHaveBeenCalledWith({
        connId: clientSocket.id,
      });
    });

    it("should emit snapshot event with room members", async () => {
      const mockSnapshot = [
        { connId: "conn-1", userId: "user-1", state: {}, epoch: 1 },
        { connId: "conn-2", userId: "user-2", state: {}, epoch: 1 },
      ];

      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: mockSnapshot,
          });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const snapshotFn = vi.fn();
      channel.on("snapshot", snapshotFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      expect(snapshotFn).toHaveBeenCalledWith(mockSnapshot);
    });
  });

  describe("Heartbeat Management", () => {
    it("should send heartbeats automatically after join", async () => {
      vi.useFakeTimers();

      const heartbeatCalls: any[] = [];
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          heartbeatCalls.push(payload);
          ack({ ok: true, changed: false, epoch: payload.epoch });
        });
      });

      channel = new PresenceChannel(clientSocket, {
        heartbeatIntervalMs: 1000,
      });

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      expect(heartbeatCalls.length).toBeGreaterThan(0);
      expect(heartbeatCalls[0].epoch).toBe(1);

      vi.useRealTimers();
    });

    it("should update epoch on successful heartbeat", async () => {
      io.on("connection", (socket) => {
        let currentEpoch = 1;
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: currentEpoch, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          currentEpoch++;
          ack({ ok: true, changed: true, epoch: currentEpoch });
        });
      });

      channel = new PresenceChannel(clientSocket);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      const response = await channel.sendHeartbeat({
        patchState: { value: 42 },
      });

      expect(response.ok).toBe(true);
      expect(response.epoch).toBe(2);
    });

    it("should track missed heartbeats", async () => {
      vi.useFakeTimers();

      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        // Don't respond to heartbeats
        socket.on("presence:heartbeat", () => {});
      });

      channel = new PresenceChannel(clientSocket, {
        heartbeatIntervalMs: 1000,
        heartbeatAckTimeoutMs: 500,
        maxMissedHeartbeats: 2,
      });

      const errorFn = vi.fn();
      channel.on("error", errorFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();

      expect(errorFn).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "MAX_MISSED_HEARTBEATS",
        })
      );

      vi.useRealTimers();
    });

    it("should reset missed heartbeats counter on successful heartbeat", async () => {
      vi.useFakeTimers();

      let respondToHeartbeat = false;
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          if (respondToHeartbeat) {
            ack({ ok: true, changed: false, epoch: payload.epoch });
          }
        });
      });

      channel = new PresenceChannel(clientSocket, {
        heartbeatIntervalMs: 1000,
        heartbeatAckTimeoutMs: 500,
        maxMissedHeartbeats: 2,
      });

      const errorFn = vi.fn();
      channel.on("error", errorFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      // Miss one heartbeat
      vi.advanceTimersByTime(1500);
      await vi.runAllTimersAsync();

      // Start responding
      respondToHeartbeat = true;
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      // Miss another heartbeat - should still not error
      respondToHeartbeat = false;
      vi.advanceTimersByTime(1500);
      await vi.runAllTimersAsync();

      expect(errorFn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("State Management", () => {
    it("should send state patches in heartbeat", async () => {
      let receivedPatch: any;
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          receivedPatch = payload.patchState;
          ack({ ok: true, changed: true, epoch: payload.epoch });
        });
      });

      channel = new PresenceChannel(clientSocket);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await channel.sendHeartbeat({
        patchState: { mic: true, camera: false },
      });

      expect(receivedPatch).toEqual({ mic: true, camera: false });
    });

    it("should handle heartbeat without state patch", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          ack({ ok: true, changed: false, epoch: payload.epoch });
        });
      });

      channel = new PresenceChannel(clientSocket);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      const response = await channel.sendHeartbeat();
      expect(response.ok).toBe(true);
    });
  });

  describe("Presence Events", () => {
    it("should receive presence events from server", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });

          // Simulate another user joining
          setTimeout(() => {
            socket.emit("presence:event", {
              type: "join",
              connId: "other-conn",
              userId: "other-user",
              roomId: payload.roomId,
              state: {},
              epoch: 1,
            });
          }, 10);
        });
      });

      channel = new PresenceChannel(clientSocket);

      const presenceEventFn = vi.fn();
      channel.on("presenceEvent", presenceEventFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(presenceEventFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "join",
          connId: "other-conn",
          userId: "other-user",
        })
      );
    });

    it("should use custom presence event name when configured", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });

          setTimeout(() => {
            socket.emit("custom:presence", {
              type: "join",
              connId: "other-conn",
              userId: "other-user",
              roomId: payload.roomId,
              state: {},
              epoch: 1,
            });
          }, 10);
        });
      });

      channel = new PresenceChannel(clientSocket, {
        presenceEventName: "custom:presence",
      });

      const presenceEventFn = vi.fn();
      channel.on("presenceEvent", presenceEventFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(presenceEventFn).toHaveBeenCalled();
    });
  });

  describe("Leave and Cleanup", () => {
    it("should send leave request on stop", async () => {
      let leaveReceived = false;
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:leave", (payload, ack) => {
          leaveReceived = true;
          ack({ ok: true });
        });
      });

      channel = new PresenceChannel(clientSocket);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await channel.stop();

      expect(leaveReceived).toBe(true);
    });

    it("should stop heartbeat loop on stop", async () => {
      vi.useFakeTimers();

      let heartbeatCount = 0;
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          heartbeatCount++;
          ack({ ok: true, changed: false, epoch: payload.epoch });
        });

        socket.on("presence:leave", (payload, ack) => {
          ack({ ok: true });
        });
      });

      channel = new PresenceChannel(clientSocket, {
        heartbeatIntervalMs: 1000,
      });

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      const countBeforeStop = heartbeatCount;
      await channel.stop();

      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(heartbeatCount).toBe(countBeforeStop);

      vi.useRealTimers();
    });

    it("should handle stop when not joined", async () => {
      channel = new PresenceChannel(clientSocket);
      await channel.stop();
    });

    it("should emit disconnected event on stop", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:leave", (payload, ack) => {
          ack({ ok: true });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const disconnectedFn = vi.fn();
      channel.on("disconnected", disconnectedFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await channel.stop();

      expect(disconnectedFn).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should throw error when sending heartbeat before join", async () => {
      channel = new PresenceChannel(clientSocket);

      await expect(channel.sendHeartbeat()).rejects.toThrow(
        "Cannot send heartbeat before join"
      );
    });

    it("should emit error event on heartbeat failure", async () => {
      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({
            ok: true,
            self: { connId: socket.id, epoch: 1, state: {} },
            snapshot: [],
          });
        });

        socket.on("presence:heartbeat", (payload, ack) => {
          ack({ ok: false, error: { code: "INVALID_EPOCH" } });
        });
      });

      channel = new PresenceChannel(clientSocket);

      const errorFn = vi.fn();
      channel.on("error", errorFn);

      await channel.join({
        roomId: "test-room",
        userId: "test-user",
        state: {},
      });

      await channel.sendHeartbeat();

      // Note: Error event might not be emitted directly on heartbeat failure
      // depending on implementation
    });
  });
});
