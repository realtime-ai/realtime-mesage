import type { Socket } from "socket.io-client";
import type {
  CustomEmitOptions,
  PresenceChannelEventMap,
  PresenceChannelOptions,
  PresenceEventEnvelope,
  PresenceHeartbeatParams,
  PresenceHeartbeatResponse,
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceStatePatch,
} from "../types";
import { EventEmitter } from "../utils/event-emitter";
import { SocketPresenceTransport } from "../transport/socket-transport";

type CustomHandler = (payload: unknown) => void;

interface ChannelState {
  roomId: string;
  userId: string;
  connId: string;
  epoch: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_MISSED_HEARTBEATS = 2;

export class PresenceChannel extends EventEmitter<PresenceChannelEventMap> {
  private readonly transport: SocketPresenceTransport;
  private readonly options: PresenceChannelOptions;
  private readonly presenceEventName: string;
  private activeSocket: Socket | null = null;
  private state: ChannelState | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private heartbeatAckTimeoutMs: number;
  private maxMissedHeartbeats: number;
  private missedHeartbeats = 0;
  private readonly customHandlers = new Map<string, Map<CustomHandler, CustomHandler>>();

  constructor(transport: SocketPresenceTransport, options?: PresenceChannelOptions) {
    super();
    this.transport = transport;
    this.options = options ?? {};
    this.heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatAckTimeoutMs =
      this.options.heartbeatAckTimeoutMs ?? Math.max(this.heartbeatIntervalMs * 0.8, 1_000);
    this.maxMissedHeartbeats = this.options.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
    this.presenceEventName = this.options.presenceEventName ?? "presence:event";
  }

  async join(params: PresenceJoinParams): Promise<PresenceJoinResponse> {
    const { socket } = await this.transport.connect({ roomId: params.roomId, userId: params.userId });
    this.attachSocket(socket);

    return new Promise<PresenceJoinResponse>((resolve, reject) => {
      socket.emit("presence:join", params, (response: PresenceJoinResponse) => {
        this.emit("joinAck", response);
        if (!response?.ok) {
          resolve(response);
          return;
        }

        this.state = {
          roomId: params.roomId,
          userId: params.userId,
          connId: response.self.connId,
          epoch: response.self.epoch,
        };

        this.emit("snapshot", response.snapshot);
        this.emit("connected", { connId: response.self.connId });
        this.resetMissedHeartbeats();
        this.startHeartbeatLoop();
        resolve(response);
      });

      socket.once("error", (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async sendHeartbeat(params?: PresenceHeartbeatParams): Promise<PresenceHeartbeatResponse> {
    if (!this.state) {
      throw new Error("Cannot send heartbeat before join");
    }

    const payload = {
      epoch: this.state.epoch,
      patchState: params?.patchState,
    };
    const socket = this.requireSocket();

    return new Promise<PresenceHeartbeatResponse>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.recordMissedHeartbeat();
        const timeoutError: PresenceHeartbeatResponse = {
          ok: false,
          error: "Heartbeat acknowledgement timeout",
        };
        this.emit("heartbeatAck", timeoutError);
        this.emit("error", new Error(timeoutError.error));
        resolve(timeoutError);
      }, this.heartbeatAckTimeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      socket.emit("presence:heartbeat", payload, (response: PresenceHeartbeatResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.emit("heartbeatAck", response);
        if (response.ok) {
          if (typeof response.epoch === "number") {
            this.state = { ...this.state!, epoch: response.epoch };
          }
          this.resetMissedHeartbeats();
        } else {
          this.recordMissedHeartbeat();
        }
        resolve(response);
      });
    });
  }

  async updateState(patch: PresenceStatePatch): Promise<PresenceHeartbeatResponse> {
    return this.sendHeartbeat({ patchState: patch });
  }

  sendCustomMessage(eventName: string): void;
  sendCustomMessage(eventName: string, payload: unknown): void;
  sendCustomMessage<T>(eventName: string, ack: (response: T) => void): void;
  sendCustomMessage<T>(eventName: string, payload: unknown, ack: (response: T) => void): void;
  sendCustomMessage<T>(eventName: string, payload: unknown, options: CustomEmitOptions): Promise<T>;
  sendCustomMessage<T = unknown>(
    eventName: string,
    payloadOrAck?: unknown | ((response: T) => void),
    ackOrOptions?: ((response: T) => void) | CustomEmitOptions
  ): Promise<T | void> | void {
    const socket = this.requireSocket();

    let payload: unknown | undefined = payloadOrAck;
    let ackCallback: ((response: T) => void) | undefined;
    let options: CustomEmitOptions | undefined;

    if (typeof payloadOrAck === "function") {
      ackCallback = payloadOrAck as (response: T) => void;
      payload = undefined;
    } else if (typeof ackOrOptions === "function") {
      ackCallback = ackOrOptions as (response: T) => void;
    } else if (ackOrOptions) {
      options = ackOrOptions as CustomEmitOptions;
    }

    if (ackCallback) {
      if (payload === undefined) {
        socket.emit(eventName, ackCallback);
      } else {
        socket.emit(eventName, payload, ackCallback);
      }
      return;
    }

    const expectsAck = options?.ack ?? false;
    if (!expectsAck) {
      if (payload === undefined) {
        socket.emit(eventName);
      } else {
        socket.emit(eventName, payload);
      }
      return;
    }

    const timeoutMs = options?.timeoutMs ?? this.heartbeatAckTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`Custom event '${eventName}' acknowledgement timeout`));
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      const ack = (response: T) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };

      if (payload === undefined) {
        socket.emit(eventName, ack);
      } else {
        socket.emit(eventName, payload, ack);
      }
    });
  }

  onCustomEvent<T = unknown>(eventName: string, handler: (payload: T) => void): () => void {
    const wrapped: CustomHandler = (payload) => {
      handler(payload as T);
    };
    this.registerCustomHandler(eventName, handler as unknown as CustomHandler, wrapped);
    return () => this.unregisterCustomHandler(eventName, handler as unknown as CustomHandler);
  }

  async leave(): Promise<void> {
    if (!this.activeSocket) {
      return;
    }
    await new Promise<void>((resolve) => {
      const socket = this.requireSocket();
      socket.emit("presence:leave", undefined, () => resolve());
    });
    this.cleanupState();
  }

  async stop(): Promise<void> {
    await this.leave();
    this.detachSocket();
    await this.transport.disconnect();
  }

  private attachSocket(socket: Socket): void {
    if (this.activeSocket?.id === socket.id) {
      return;
    }

    this.detachSocket();
    this.activeSocket = socket;

    socket.on(this.presenceEventName, (event: PresenceEventEnvelope) => {
      this.emit("presenceEvent", event);
    });

    socket.on("disconnect", (reason: string) => {
      this.emit("disconnected", { reason });
      this.cleanupState();
    });

    this.customHandlers.forEach((handlerMap, eventName) => {
      handlerMap.forEach((wrapper) => {
        socket.on(eventName, wrapper);
      });
    });
  }

  private detachSocket(): void {
    const socket = this.activeSocket;
    if (!socket) {
      return;
    }
    socket.off(this.presenceEventName);
    socket.off("disconnect");
    this.customHandlers.forEach((handlerMap, eventName) => {
      handlerMap.forEach((wrapper) => {
        socket.off(eventName, wrapper);
      });
    });
    this.activeSocket = null;
  }

  private startHeartbeatLoop(): void {
    this.stopHeartbeatLoop();
    if (this.heartbeatIntervalMs <= 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanupState(): void {
    this.stopHeartbeatLoop();
    this.state = null;
    this.detachSocket();
  }

  private resetMissedHeartbeats(): void {
    this.missedHeartbeats = 0;
  }

  private recordMissedHeartbeat(): void {
    this.missedHeartbeats += 1;
    if (this.missedHeartbeats > this.maxMissedHeartbeats) {
      this.emit("error", new Error("Too many missed heartbeats"));
      this.resetMissedHeartbeats();
    }
  }

  private registerCustomHandler(eventName: string, handler: CustomHandler, wrapper: CustomHandler): void {
    let handlerMap = this.customHandlers.get(eventName);
    if (!handlerMap) {
      handlerMap = new Map();
      this.customHandlers.set(eventName, handlerMap);
    }
    const socket = this.activeSocket;
    const existing = handlerMap.get(handler);
    if (existing && socket) {
      socket.off(eventName, existing);
    }
    handlerMap.set(handler, wrapper);
    if (socket) {
      socket.on(eventName, wrapper);
    }
  }

  private unregisterCustomHandler(eventName: string, handler: CustomHandler): void {
    const handlerMap = this.customHandlers.get(eventName);
    if (!handlerMap) {
      return;
    }
    const wrapper = handlerMap.get(handler);
    const socket = this.activeSocket;
    if (wrapper && socket) {
      socket.off(eventName, wrapper);
    }
    handlerMap.delete(handler);
    if (handlerMap.size === 0) {
      this.customHandlers.delete(eventName);
    }
  }

  private requireSocket(): Socket {
    if (!this.activeSocket) {
      throw new Error("Socket is not connected");
    }
    return this.activeSocket;
  }
}
