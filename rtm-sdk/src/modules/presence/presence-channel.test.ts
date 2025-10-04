import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PresenceChannel } from "./presence-channel";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { AddressInfo } from "net";

describe("PresenceChannel", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let port: number;
  let clientSocket: ClientSocket;

  beforeAll(async () => {
    // Create server
    httpServer = createServer();
    io = new SocketIOServer(httpServer);

    // Start listening
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
          self: { connId: 'test-conn', epoch: 1 },
          snapshot: []
        });
      });

      socket.on("presence:leave", (_payload, ack) => {
        ack?.();
      });
    });

    // Connect client
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

  it("should create and join channel", async () => {
    const channel = new PresenceChannel(clientSocket);

    const response = await channel.join({
      roomId: "test-room",
      userId: "test-user",
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.self.connId).toBe('test-conn');
      expect(response.self.epoch).toBe(1);
      expect(response.snapshot).toEqual([]);
    }

    await channel.stop();
  });

  it("should send heartbeat after joining", async () => {
    const channel = new PresenceChannel(clientSocket);

    // Setup heartbeat handler on existing socket
    const socket = io.sockets.sockets.values().next().value;
    if (socket) {
      socket.on("presence:heartbeat", (payload, ack) => {
        ack({ ok: true, epoch: payload.epoch + 1 });
      });
    }

    const joinResponse = await channel.join({
      roomId: "test-room",
      userId: "test-user",
    });

    expect(joinResponse.ok).toBe(true);

    const heartbeatResponse = await channel.sendHeartbeat();
    expect(heartbeatResponse.ok).toBe(true);
    if (heartbeatResponse.ok && typeof heartbeatResponse.epoch === 'number') {
      expect(heartbeatResponse.epoch).toBe(2);
    }

    await channel.stop();
  });

  it("should handle custom events", async () => {
    const channel = new PresenceChannel(clientSocket);

    // Setup server handler on existing socket
    const socket = io.sockets.sockets.values().next().value;
    if (socket) {
      socket.on("test:broadcast", () => {
        socket.emit("test:event", { message: "hello" });
      });
    }

    await channel.join({
      roomId: "test-room",
      userId: "test-user",
    });

    const receivedEvents: any[] = [];

    // Listen for custom events
    const unsubscribe = channel.on("test:event", (data) => {
      receivedEvents.push(data);
    });

    // Trigger broadcast
    channel.emit("test:broadcast", {});

    // Wait a bit for event to be received
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual({ message: "hello" });

    unsubscribe();
    await channel.stop();
  });
});