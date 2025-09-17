import { io, type Socket } from "socket.io-client";
import type { Logger, PresenceClientConfig } from "../types";

export class SocketPresenceTransport {
  private socket: Socket | null = null;
  private readonly config: PresenceClientConfig;
  private readonly logger: Logger;

  constructor(config: PresenceClientConfig) {
    this.config = config;
    this.logger = config.logger ?? defaultLogger;
  }

  async connect(additionalQuery?: Record<string, string>): Promise<Socket> {
    if (this.socket?.connected) {
      return this.socket;
    }

    const authQuery = await resolveAuthQuery(this.config.authProvider);

    return new Promise<Socket>((resolve, reject) => {
      const socket = io(this.config.baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelayMax: 5_000,
        query: { ...authQuery, ...additionalQuery },
      });

      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        socket.off("error", onError);
      };

      const onConnect = () => {
        cleanup();
        this.socket = socket;
        this.logger.debug("Socket connected", { id: socket.id });
        const socketId = socket.id ?? "";
        this.config.hooks?.onConnect?.({ connId: socketId, socketId });
        resolve(socket);
      };

      const onError = (error: unknown) => {
        cleanup();
        this.logger.error("Socket connection error", error);
        socket.disconnect();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const onReconnect = (attempt: number) => {
        const socketId = socket.id ?? "";
        this.config.hooks?.onReconnect?.({ attempt, socketId });
      };

      const onReconnectAttempt = (attempt: number) => {
        const socketId = socket.id ?? "";
        this.config.hooks?.onReconnectAttempt?.({ attempt, socketId });
      };

      const onDisconnect = (reason: string) => {
        const socketId = socket.id ?? "";
        this.config.hooks?.onDisconnect?.({ reason, socketId });
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.once("error", onError);
      socket.on("reconnect", onReconnect);
      socket.on("reconnect_attempt", onReconnectAttempt);
      socket.on("disconnect", onDisconnect);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }
    const target = this.socket;
    this.socket = null;
    if (target.connected) {
      await new Promise<void>((resolve) => {
        target.once("disconnect", () => resolve());
        target.disconnect();
        setTimeout(() => resolve(), 500); // fail-safe
      });
      this.logger.debug("Socket disconnected", { id: target.id });
    } else {
      target.disconnect();
    }
  }

  getHooks() {
    return this.config.hooks;
  }

  fireMessageHook(eventName: string, payload: unknown): void {
    this.config.hooks?.onMessage?.(eventName, payload);
  }
}

async function resolveAuthQuery(
  provider: PresenceClientConfig["authProvider"]
): Promise<Record<string, string>> {
  if (!provider) {
    return {};
  }
  const value = await provider();
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [key, String(val)])
  );
}

const defaultLogger: Logger = {
  debug: () => {
    /* noop */
  },
  info: () => {
    /* noop */
  },
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};
