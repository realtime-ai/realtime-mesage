import type { Redis as RedisClient } from "ioredis";
import { Server as SocketIOServer } from "socket.io";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RealtimeServer } from "./realtime-server";
import type { RealtimeModule, ModuleContext } from "./types";
import { createMockRedis, createMockLogger } from "../test-utils";
import { createServer } from "http";

describe("RealtimeServer", () => {
  let redis: RedisClient;
  let io: SocketIOServer;
  let server: RealtimeServer;

  beforeEach(async () => {
    redis = createMockRedis();
    const httpServer = createServer();
    io = new SocketIOServer(httpServer);
    await redis.flushall();
  });

  afterEach(async () => {
    await server?.shutdown();
    io?.close();
    if (typeof (redis as any).disconnect === "function") {
      (redis as any).disconnect();
    }
  });

  describe("Module Registration", () => {
    it("should register modules before start", () => {
      server = new RealtimeServer({ io, redis });
      const module: RealtimeModule = {
        name: "test-module",
        register: vi.fn(),
      };

      server.use(module);
      expect(() => server.use(module)).not.toThrow();
    });

    it("should throw error when registering after start", async () => {
      server = new RealtimeServer({ io, redis });
      const module: RealtimeModule = {
        name: "test-module",
        register: vi.fn(),
      };

      await server.start();

      expect(() => server.use(module)).toThrow(
        'Cannot register module "test-module" after server has started'
      );
    });

    it("should call module register method with context", async () => {
      server = new RealtimeServer({ io, redis });
      const registerFn = vi.fn();
      const module: RealtimeModule = {
        name: "test-module",
        register: registerFn,
      };

      server.use(module);
      await server.start();

      expect(registerFn).toHaveBeenCalledOnce();
      expect(registerFn).toHaveBeenCalledWith(
        expect.objectContaining({
          io,
          redis,
          logger: expect.any(Object),
        })
      );
    });

    it("should register multiple modules in order", async () => {
      server = new RealtimeServer({ io, redis });
      const order: string[] = [];

      const module1: RealtimeModule = {
        name: "module-1",
        register: async () => {
          order.push("module-1");
        },
      };

      const module2: RealtimeModule = {
        name: "module-2",
        register: async () => {
          order.push("module-2");
        },
      };

      server.use(module1);
      server.use(module2);
      await server.start();

      expect(order).toEqual(["module-1", "module-2"]);
    });

    it("should support async module registration", async () => {
      server = new RealtimeServer({ io, redis });
      let resolved = false;

      const module: RealtimeModule = {
        name: "async-module",
        register: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          resolved = true;
        },
      };

      server.use(module);
      await server.start();

      expect(resolved).toBe(true);
    });
  });

  describe("Lifecycle Management", () => {
    it("should throw error when starting twice", async () => {
      server = new RealtimeServer({ io, redis });
      await server.start();

      await expect(server.start()).rejects.toThrow("Server already started");
    });

    it("should call onConnection for all modules on socket connection", async () => {
      server = new RealtimeServer({ io, redis });
      const onConnectionFn1 = vi.fn();
      const onConnectionFn2 = vi.fn();

      const module1: RealtimeModule = {
        name: "module-1",
        register: vi.fn(),
        onConnection: onConnectionFn1,
      };

      const module2: RealtimeModule = {
        name: "module-2",
        register: vi.fn(),
        onConnection: onConnectionFn2,
      };

      server.use(module1);
      server.use(module2);
      await server.start();

      // Simulate socket connection
      const mockSocket = { id: "test-socket" };
      io.emit("connection", mockSocket);

      expect(onConnectionFn1).toHaveBeenCalledWith(
        mockSocket,
        expect.objectContaining({ io, redis })
      );
      expect(onConnectionFn2).toHaveBeenCalledWith(
        mockSocket,
        expect.objectContaining({ io, redis })
      );
    });

    it("should call onShutdown for all modules during shutdown", async () => {
      server = new RealtimeServer({ io, redis });
      const onShutdownFn1 = vi.fn();
      const onShutdownFn2 = vi.fn();

      const module1: RealtimeModule = {
        name: "module-1",
        register: vi.fn(),
        onShutdown: onShutdownFn1,
      };

      const module2: RealtimeModule = {
        name: "module-2",
        register: vi.fn(),
        onShutdown: onShutdownFn2,
      };

      server.use(module1);
      server.use(module2);
      await server.start();
      await server.shutdown();

      expect(onShutdownFn1).toHaveBeenCalledOnce();
      expect(onShutdownFn2).toHaveBeenCalledOnce();
    });

    it("should handle errors during module shutdown gracefully", async () => {
      const logger = createMockLogger();
      server = new RealtimeServer({ io, redis, logger });

      const module1: RealtimeModule = {
        name: "failing-module",
        register: vi.fn(),
        onShutdown: async () => {
          throw new Error("Shutdown failed");
        },
      };

      const module2: RealtimeModule = {
        name: "normal-module",
        register: vi.fn(),
        onShutdown: vi.fn(),
      };

      server.use(module1);
      server.use(module2);
      await server.start();
      await server.shutdown();

      expect(logger.error).toHaveBeenCalledWith(
        "Failed to shutdown module: failing-module",
        expect.any(Error)
      );
      expect(module2.onShutdown).toHaveBeenCalled();
    });

    it("should support modules without optional lifecycle hooks", async () => {
      server = new RealtimeServer({ io, redis });
      const module: RealtimeModule = {
        name: "minimal-module",
        register: vi.fn(),
      };

      server.use(module);
      await server.start();

      const mockSocket = { id: "test-socket" };
      io.emit("connection", mockSocket);

      await server.shutdown();

      expect(module.register).toHaveBeenCalled();
    });
  });

  describe("Logger Integration", () => {
    it("should use custom logger when provided", async () => {
      const logger = createMockLogger();
      server = new RealtimeServer({ io, redis, logger });

      const module: RealtimeModule = {
        name: "test-module",
        register: vi.fn(),
      };

      server.use(module);
      await server.start();

      expect(logger.info).toHaveBeenCalledWith("Module registered: test-module");
    });

    it("should use default logger when not provided", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      server = new RealtimeServer({ io, redis });

      const module: RealtimeModule = {
        name: "test-module",
        register: vi.fn(),
      };

      server.use(module);
      await server.start();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Module registered: test-module",
        ""
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe("Module Context", () => {
    it("should provide io instance to modules", async () => {
      server = new RealtimeServer({ io, redis });
      let capturedContext: ModuleContext | undefined;

      const module: RealtimeModule = {
        name: "test-module",
        register: (context) => {
          capturedContext = context;
        },
      };

      server.use(module);
      await server.start();

      expect(capturedContext?.io).toBe(io);
    });

    it("should provide redis instance to modules", async () => {
      server = new RealtimeServer({ io, redis });
      let capturedContext: ModuleContext | undefined;

      const module: RealtimeModule = {
        name: "test-module",
        register: (context) => {
          capturedContext = context;
        },
      };

      server.use(module);
      await server.start();

      expect(capturedContext?.redis).toBe(redis);
    });

    it("should provide logger instance to modules", async () => {
      const logger = createMockLogger();
      server = new RealtimeServer({ io, redis, logger });
      let capturedContext: ModuleContext | undefined;

      const module: RealtimeModule = {
        name: "test-module",
        register: (context) => {
          capturedContext = context;
        },
      };

      server.use(module);
      await server.start();

      expect(capturedContext?.logger).toBe(logger);
    });
  });
});
