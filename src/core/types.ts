import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface ModuleContext {
  io: Server;
  redis: Redis;
  logger: Logger;
}

export interface RealtimeModule {
  name: string;
  register(context: ModuleContext): void | Promise<void>;
  onConnection?(socket: Socket, context: ModuleContext): void;
  onShutdown?(): void | Promise<void>;
}
