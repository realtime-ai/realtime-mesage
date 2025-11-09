import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { RealtimeClient } from "./realtime-client";
import type { ClientModule, RealtimeClientConfig } from "./types";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import type { AddressInfo } from "net";

describe("RealtimeClient", () => {
  let httpServer: any;
  let io: SocketIOServer;
  let port: number;
  let client: RealtimeClient;

  // Silent logger to suppress test output
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
      httpServer.listen(0, (err: Error | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        port = (addr as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (client) {
      try {
        await Promise.race([
          client.shutdown(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown timeout')), 5000)
          )
        ]);
      } catch (error) {
        // Force cleanup on timeout
        const socket = client.getSocket();
        if (socket) {
          socket.removeAllListeners();
          socket.disconnect();
        }
      }
      client = null as any;
    }
  });

  afterAll(async () => {
    if (!io || !httpServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close((err: any) => {
        // Ignore ERR_SERVER_NOT_RUNNING as io.close() may have already closed it
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error("httpServer.close error:", err);
        }
        resolve();
      });
    });
  });

  describe("Connection Management", () => {
    it("should connect to server successfully", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(client.getSocket()).not.toBeNull();
    });

    it("should handle connection errors gracefully", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: "http://localhost:99999",
        reconnection: false,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);

      await expect(client.connect()).rejects.toThrow();
      expect(client.isConnected()).toBe(false);
    });

    it("should warn when connecting twice", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger,
      };

      client = new RealtimeClient(config);
      await client.connect();
      await client.connect();

      expect(logger.warn).toHaveBeenCalledWith("Already connected");
    });

    it("should disconnect cleanly", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.connect();
      await client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(client.getSocket()).toBeNull();
    });

    it("should handle disconnect when not connected", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.disconnect();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe("Module Registration", () => {
    it("should register modules before connection", () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);

      const module: ClientModule = {
        name: "test-module",
        onConnected: vi.fn(),
      };

      expect(() => client.use(module)).not.toThrow();
    });

    it("should throw error when registering after connection", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      const module: ClientModule = {
        name: "test-module",
        onConnected: vi.fn(),
      };

      expect(() => client.use(module)).toThrow(
        'Cannot register module "test-module" after connection is established'
      );
    });

    it("should call module onConnected on connect", async () => {
      const onConnectedFn = vi.fn();

      const module: ClientModule = {
        name: "test-module",
        onConnected: onConnectedFn,
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      client.use(module);
      await client.connect();

      expect(onConnectedFn).toHaveBeenCalledOnce();
      expect(onConnectedFn).toHaveBeenCalledWith(
        expect.objectContaining({
          socket: expect.any(Object),
          logger: expect.any(Object),
          config,
        })
      );
    });

    it("should call module onDisconnected on disconnect", async () => {
      const onDisconnectedFn = vi.fn();

      const module: ClientModule = {
        name: "test-module",
        onDisconnected: onDisconnectedFn,
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      client.use(module);
      await client.connect();
      await client.disconnect();

      expect(onDisconnectedFn).toHaveBeenCalled();
    });

    it("should call module onShutdown on shutdown", async () => {
      const onShutdownFn = vi.fn();

      const module: ClientModule = {
        name: "test-module",
        onShutdown: onShutdownFn,
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      client.use(module);
      await client.connect();
      await client.shutdown();

      expect(onShutdownFn).toHaveBeenCalled();
    });

    it("should handle module initialization errors", async () => {
      const module: ClientModule = {
        name: "failing-module",
        onConnected: async () => {
          throw new Error("Module init failed");
        },
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      client.use(module);

      await expect(client.connect()).rejects.toThrow("Module init failed");
      expect(client.isConnected()).toBe(false);
    });

    it("should handle module disconnect errors gracefully", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const module: ClientModule = {
        name: "failing-module",
        onDisconnected: async () => {
          throw new Error("Disconnect failed");
        },
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger,
      };

      client = new RealtimeClient(config);
      client.use(module);
      await client.connect();
      await client.disconnect();

      expect(logger.error).toHaveBeenCalledWith(
        "Failed to disconnect module: failing-module",
        expect.any(Error)
      );
    });
  });

  describe("Auth Provider", () => {
    it("should call auth provider and send query params", async () => {
      const authProvider = vi.fn(async () => ({
        userId: "test-user",
        token: "test-token",
      }));

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        authProvider,
      };

      let receivedQuery: any;
      io.on("connection", (socket) => {
        receivedQuery = socket.handshake.query;
      });

      client = new RealtimeClient(config);
      await client.connect();

      expect(authProvider).toHaveBeenCalled();
      expect(receivedQuery).toMatchObject({
        userId: "test-user",
        token: "test-token",
      });
    });

    it("should handle auth provider errors", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const authProvider = vi.fn(async () => {
        throw new Error("Auth failed");
      });

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        authProvider,
        logger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      expect(logger.error).toHaveBeenCalledWith(
        "Auth provider failed",
        expect.any(Error)
      );
    });

    it("should handle auth provider returning invalid data", async () => {
      const authProvider = vi.fn(async () => null as any);

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        authProvider,
      };

      let receivedQuery: any;
      io.on("connection", (socket) => {
        receivedQuery = socket.handshake.query;
      });

      client = new RealtimeClient(config);
      await client.connect();

      // Socket.IO always adds EIO and transport, just verify no custom auth fields
      expect(Object.keys(receivedQuery).filter(k => k !== 'EIO' && k !== 'transport')).toEqual([]);
    });
  });

  describe("Presence Channel Integration", () => {
    it("should throw error when creating channel before connection", () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);

      expect(() => client.createPresenceChannel()).toThrow(
        "Cannot create presence channel before connection"
      );
    });

    it("should create presence channel after connection", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      const channel = client.createPresenceChannel();
      expect(channel).toBeDefined();
    });

    it("should merge global and channel-specific presence options", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        presence: {
          heartbeatIntervalMs: 5000,
        },
      };

      client = new RealtimeClient(config);
      await client.connect();

      const channel = client.createPresenceChannel({
        heartbeatIntervalMs: 10000,
      });

      expect(channel).toBeDefined();
    });

    it("should stop all presence channels on shutdown", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
      };

      io.on("connection", (socket) => {
        socket.on("presence:join", (payload, ack) => {
          ack({ ok: true, self: { connId: 'test-conn', epoch: 1 }, snapshot: [] });
        });
        socket.on("presence:leave", (payload, ack) => {
          ack?.();
        });
      });

      client = new RealtimeClient(config);
      await client.connect();

      const channel1 = client.createPresenceChannel();
      const channel2 = client.createPresenceChannel();

      const stopSpy1 = vi.spyOn(channel1, "stop");
      const stopSpy2 = vi.spyOn(channel2, "stop");

      await client.shutdown();

      expect(stopSpy1).toHaveBeenCalled();
      expect(stopSpy2).toHaveBeenCalled();
    });
  });

  describe("Reconnection Handling", () => {
    it("should support custom reconnection options", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelayMax: 3000,
      };

      client = new RealtimeClient(config);
      await client.connect();

      const socket = client.getSocket();
      expect(socket?.io.opts.reconnection).toBe(true);
      expect(socket?.io.opts.reconnectionAttempts).toBe(10);
      expect(socket?.io.opts.reconnectionDelayMax).toBe(3000);
    });

    it("should disable reconnection when specified", async () => {
      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        reconnection: false,
        logger: silentLogger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      const socket = client.getSocket();
      expect(socket?.io.opts.reconnection).toBe(false);
    });
  });

  describe("Logger Integration", () => {
    it("should use custom logger when provided", async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        logger,
      };

      client = new RealtimeClient(config);
      await client.connect();

      expect(logger.info).toHaveBeenCalledWith(
        "Socket connected",
        expect.any(Object)
      );
    });

    it("should use default logger when not provided", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const config: RealtimeClientConfig = {
        baseUrl: `http://localhost:${port}`,
        // Intentionally not providing logger to test default behavior
      };

      client = new RealtimeClient(config);
      await client.connect();

      expect(client.isConnected()).toBe(true);
      // Default logger only logs warn and error to console, not info/debug

      // Disconnect to trigger a warning
      await client.disconnect();
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
