import type { Redis as RedisClient } from "ioredis";
import Redis from "ioredis-mock";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import type { Server, Socket } from "socket.io";
import { createServer } from "http";
import type { AddressInfo } from "net";

/**
 * Create a mock Redis client for testing
 */
export function createMockRedis(): RedisClient {
  return new (Redis as unknown as { new (): RedisClient })();
}

/**
 * Wait for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Sleep for a given duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a test Socket.IO server with an HTTP server
 */
export interface TestServer {
  io: Server;
  port: number;
  close: () => Promise<void>;
}

export async function createTestServer(): Promise<TestServer> {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });

  const address = httpServer.address() as AddressInfo;
  const port = address.port;

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      io.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { io, port, close };
}

/**
 * Create a test Socket.IO client
 */
export interface TestClient {
  socket: ClientSocket;
  disconnect: () => void;
}

export function createTestClient(
  port: number,
  options?: Record<string, any>
): TestClient {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    ...options,
  });

  const disconnect = () => {
    socket.disconnect();
  };

  return { socket, disconnect };
}

/**
 * Wait for a socket to connect
 */
export function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      socket.off("error", onError);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.once("error", onError);
  });
}

/**
 * Emit an event and wait for acknowledgement
 */
export function emitWithAck<T = any>(
  socket: ClientSocket,
  event: string,
  payload: any,
  timeoutMs = 2000
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("Socket not connected"));
      return;
    }

    let completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      reject(new Error(`Timeout waiting for ack on event: ${event}`));
    }, timeoutMs);

    try {
      socket.emit(event, payload, (response: T) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(response);
      });
    } catch (error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * Mock logger for testing
 */
export function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Create a mock Socket.IO socket for unit testing
 */
export interface MockSocket {
  id: string;
  data: Record<string, any>;
  connected: boolean;
  handlers: Map<string, Function[]>;
  emittedEvents: Array<{ event: string; args: any[] }>;
  on: (event: string, handler: Function) => void;
  once: (event: string, handler: Function) => void;
  emit: (event: string, ...args: any[]) => void;
  off: (event: string, handler?: Function) => void;
  join: (room: string) => Promise<void>;
  leave: (room: string) => Promise<void>;
  disconnect: () => void;
  to: (room: string) => MockSocket;
  in: (room: string) => MockSocket;
}

export function createMockSocket(id = "mock-socket-id"): MockSocket {
  const socket: MockSocket = {
    id,
    data: {},
    connected: true,
    handlers: new Map(),
    emittedEvents: [],

    on(event: string, handler: Function) {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, []);
      }
      this.handlers.get(event)!.push(handler);
    },

    once(event: string, handler: Function) {
      const wrappedHandler = (...args: any[]) => {
        handler(...args);
        this.off(event, wrappedHandler);
      };
      this.on(event, wrappedHandler);
    },

    emit(event: string, ...args: any[]) {
      this.emittedEvents.push({ event, args });
      const handlers = this.handlers.get(event);
      if (handlers) {
        handlers.forEach((handler) => handler(...args));
      }
    },

    off(event: string, handler?: Function) {
      if (!handler) {
        this.handlers.delete(event);
      } else {
        const handlers = this.handlers.get(event);
        if (handlers) {
          const index = handlers.indexOf(handler);
          if (index > -1) {
            handlers.splice(index, 1);
          }
        }
      }
    },

    async join(room: string) {
      // Mock implementation
    },

    async leave(room: string) {
      // Mock implementation
    },

    disconnect() {
      this.connected = false;
      this.emit("disconnect", "forced disconnect");
    },

    to(room: string) {
      return this;
    },

    in(room: string) {
      return this;
    },
  };

  return socket;
}
