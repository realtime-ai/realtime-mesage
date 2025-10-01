import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import type { RealtimeModule, ModuleContext, Logger } from "./types";

export interface RealtimeServerOptions {
  io: Server;
  redis: Redis;
  logger?: Logger;
}

const defaultLogger: Logger = {
  debug: () => {
    /* noop */
  },
  info: (message: string, meta?: unknown) => {
    console.log(message, meta ?? "");
  },
  warn: (message: string, meta?: unknown) => {
    console.warn(message, meta ?? "");
  },
  error: (message: string, meta?: unknown) => {
    console.error(message, meta ?? "");
  },
};

export class RealtimeServer {
  private modules: RealtimeModule[] = [];
  private context: ModuleContext;
  private started = false;

  constructor(options: RealtimeServerOptions) {
    this.context = {
      io: options.io,
      redis: options.redis,
      logger: options.logger ?? defaultLogger,
    };
  }

  use(module: RealtimeModule): void {
    if (this.started) {
      throw new Error(
        `Cannot register module "${module.name}" after server has started`
      );
    }
    this.modules.push(module);
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Server already started");
    }

    for (const module of this.modules) {
      await module.register(this.context);
      this.context.logger.info(`Module registered: ${module.name}`);
    }

    this.context.io.on("connection", (socket: Socket) => {
      this.modules.forEach((module) => {
        module.onConnection?.(socket, this.context);
      });
    });

    this.started = true;
  }

  async shutdown(): Promise<void> {
    for (const module of this.modules) {
      try {
        await module.onShutdown?.();
      } catch (error) {
        this.context.logger.error(`Failed to shutdown module: ${module.name}`, error);
      }
    }
    this.started = false;
  }
}
