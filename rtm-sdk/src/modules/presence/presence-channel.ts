import type { Socket } from "socket.io-client";
import { EventEmitter } from "../../core/event-emitter";
import type {
  PresenceChannelEventMap,
  PresenceChannelOptions,
  PresenceEventEnvelope,
  PresenceHeartbeatParams,
  PresenceHeartbeatResponse,
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceStatePatch,
} from "./types";

export interface CustomEmitOptions {
  ack?: boolean;
  timeoutMs?: number;
}

type CustomHandler = (payload: unknown) => void;

interface ChannelState {
  roomId: string;
  userId: string;
  connId: string;
  epoch: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_MISSED_HEARTBEATS = 2;
const BUILTIN_CHANNEL_EVENTS = new Set<keyof PresenceChannelEventMap>([
  "connected",
  "disconnected",
  "joinAck",
  "heartbeatAck",
  "presenceEvent",
  "snapshot",
  "error",
]);

export class PresenceChannel extends EventEmitter<PresenceChannelEventMap> {
  private readonly socket: Socket;
  private readonly options: PresenceChannelOptions;
  private readonly presenceEventName: string;
  private state: ChannelState | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private heartbeatAckTimeoutMs: number;
  private maxMissedHeartbeats: number;
  private missedHeartbeats = 0;
  private readonly customHandlers = new Map<string, Map<CustomHandler, CustomHandler>>();

  constructor(socket: Socket, options?: PresenceChannelOptions) {
    super();
    this.socket = socket;
    this.options = options ?? {};
    this.heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatAckTimeoutMs =
      this.options.heartbeatAckTimeoutMs ?? Math.max(this.heartbeatIntervalMs * 0.8, 1_000);
    this.maxMissedHeartbeats = this.options.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
    this.presenceEventName = this.options.presenceEventName ?? "presence:event";
  }

  async join(params: PresenceJoinParams): Promise<PresenceJoinResponse> {
    this.attachSocketHandlers();

    return new Promise<PresenceJoinResponse>((resolve, reject) => {
      this.socket.emit("presence:join", params, (response: PresenceJoinResponse) => {
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

      this.socket.once("error", (error: unknown) => {
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

      this.socket.emit("presence:heartbeat", payload, (response: PresenceHeartbeatResponse) => {
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

  emit(eventName: string): void;
  emit(eventName: string, payload: unknown): void;
  emit<T>(eventName: string, ack: (response: T) => void): void;
  emit<T>(eventName: string, payload: unknown, ack: (response: T) => void): void;
  emit<T>(eventName: string, payload: unknown, options: CustomEmitOptions): Promise<T>;
  emit<T = unknown>(
    eventName: string,
    payloadOrAck?: unknown | ((response: T) => void),
    ackOrOptions?: ((response: T) => void) | CustomEmitOptions
  ): Promise<T | void> | void {
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
        this.socket.emit(eventName, ackCallback);
      } else {
        this.socket.emit(eventName, payload, ackCallback);
      }
      return;
    }

    const expectsAck = options?.ack ?? false;
    if (!expectsAck) {
      if (payload === undefined) {
        this.socket.emit(eventName);
      } else {
        this.socket.emit(eventName, payload);
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
        this.socket.emit(eventName, ack);
      } else {
        this.socket.emit(eventName, payload, ack);
      }
    });
  }

  on<EventName extends keyof PresenceChannelEventMap>(
    eventName: EventName,
    handler: (payload: PresenceChannelEventMap[EventName]) => void
  ): () => void;
  on<T = unknown>(eventName: string, handler: (payload: T) => void): () => void;
  on(eventName: string, handler: (payload: unknown) => void): () => void {
    if (BUILTIN_CHANNEL_EVENTS.has(eventName as keyof PresenceChannelEventMap)) {
      return super.on(
        eventName as keyof PresenceChannelEventMap,
        handler as (payload: PresenceChannelEventMap[keyof PresenceChannelEventMap]) => void
      );
    }
    const socketHandler: CustomHandler = (payload) => {
      handler(payload);
    };
    this.registerCustomHandler(eventName, handler as unknown as CustomHandler, socketHandler);
    return () => this.unregisterCustomHandler(eventName, handler as unknown as CustomHandler);
  }

  async leave(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socket.emit("presence:leave", undefined, () => resolve());
    });
    this.cleanupState();
  }

  async stop(): Promise<void> {
    await this.leave();
    this.detachSocketHandlers();
  }

  private attachSocketHandlers(): void {
    this.socket.on(this.presenceEventName, (event: PresenceEventEnvelope) => {
      this.emit("presenceEvent", event);
    });

    this.socket.on("disconnect", (reason: string) => {
      this.emit("disconnected", { reason });
      this.cleanupState();
    });

    this.customHandlers.forEach((handlerMap, eventName) => {
      handlerMap.forEach((wrapper) => {
        this.socket.on(eventName, wrapper);
      });
    });
  }

  private detachSocketHandlers(): void {
    this.socket.off(this.presenceEventName);
    this.socket.off("disconnect");
    this.customHandlers.forEach((handlerMap, eventName) => {
      handlerMap.forEach((wrapper) => {
        this.socket.off(eventName, wrapper);
      });
    });
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
    const existing = handlerMap.get(handler);
    if (existing) {
      this.socket.off(eventName, existing);
    }
    handlerMap.set(handler, wrapper);
    this.socket.on(eventName, wrapper);
  }

  private unregisterCustomHandler(eventName: string, handler: CustomHandler): void {
    const handlerMap = this.customHandlers.get(eventName);
    if (!handlerMap) {
      return;
    }
    const wrapper = handlerMap.get(handler);
    if (wrapper) {
      this.socket.off(eventName, wrapper);
    }
    handlerMap.delete(handler);
    if (handlerMap.size === 0) {
      this.customHandlers.delete(eventName);
    }
  }
}
