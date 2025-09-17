import { io, type Socket } from "socket.io-client";
import type { Logger, PresenceClientConfig } from "../types";

export interface PresenceSocket {
  socket: Socket;
  disconnect(): Promise<void>;
}

export class SocketPresenceTransport {
  private socket: Socket | null = null;
  private readonly config: PresenceClientConfig;
  private readonly logger: Logger;

  constructor(config: PresenceClientConfig) {
    this.config = config;
    this.logger = config.logger ?? defaultLogger;
  }

  async connect(additionalQuery?: Record<string, string>): Promise<PresenceSocket> {
    if (this.socket?.connected) {
      return { socket: this.socket, disconnect: () => this.disconnect() };
    }

    const authQuery = await resolveAuthQuery(this.config.authProvider);

    return new Promise<PresenceSocket>((resolve, reject) => {
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
        resolve({
          socket,
          disconnect: async () => {
            cleanup();
            await this.disconnect();
          },
        });
      };

      const onError = (error: unknown) => {
        cleanup();
        this.logger.error("Socket connection error", error);
        socket.disconnect();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.once("error", onError);
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
