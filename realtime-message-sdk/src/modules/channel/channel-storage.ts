import type { Socket } from "socket.io-client";
import { EventEmitter } from "../../core/event-emitter";
import type { Logger } from "../../core/types";
import {
  MetadataConflictError,
  MetadataError,
  MetadataLockError,
  MetadataValidationError,
} from "../metadata/channel-metadata-client";
import type {
  StorageEvent,
  StorageItem,
  StorageOptions,
  StorageResponse,
  LockOptions,
  ChannelStorageEvents,
} from "./types";

// Renamed errors for storage context
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageConflictError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export class StorageLockError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageLockError";
  }
}

export class StorageValidationError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

interface StorageAckSuccessLegacy {
  ok: true;
  data: StorageResponse;
}

interface StorageAckSuccessInline extends StorageResponse {
  ok: true;
}

type StorageAckSuccess = StorageAckSuccessLegacy | StorageAckSuccessInline;

interface StorageAckFailure {
  ok: false;
  error: string;
  code?: string;
}

type StorageAck = StorageAckSuccess | StorageAckFailure;

/**
 * ChannelStorage provides storage operations for a specific channel.
 * It's the renamed and improved version of ChannelMetadataClient.
 */
export class ChannelStorage<TSchema = Record<string, unknown>> extends EventEmitter<ChannelStorageEvents> {
  private readonly socket: Socket;
  private readonly logger: Logger;
  private readonly channelName: string;
  private readonly channelType: string;
  private readonly metadataEventName: string;
  private listenerAttached = false;

  constructor(
    socket: Socket,
    channelName: string,
    channelType: string,
    logger: Logger,
    metadataEventName = "metadata:event"
  ) {
    super();
    this.socket = socket;
    this.channelName = channelName;
    this.channelType = channelType;
    this.logger = logger;
    this.metadataEventName = metadataEventName;
    this.attachListener();
  }

  dispose(): void {
    this.detachListener();
    this.removeAll();
  }

  /**
   * Get a single storage value by key
   */
  async get<K extends keyof TSchema>(key: K): Promise<TSchema[K] | null> {
    const response = await this.getAll();
    const entry = response.metadata[key as string];
    if (!entry) {
      return null;
    }
    try {
      return JSON.parse(entry.value) as TSchema[K];
    } catch {
      return entry.value as TSchema[K];
    }
  }

  /**
   * Set a single storage value by key
   */
  async set<K extends keyof TSchema>(
    key: K,
    value: TSchema[K],
    options?: StorageOptions
  ): Promise<void> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    await this.setMany({ [key]: serialized } as Partial<TSchema>, options);
  }

  /**
   * Remove a single storage key
   */
  async remove<K extends keyof TSchema>(key: K, options?: StorageOptions): Promise<void> {
    await this.removeMany([key], options);
  }

  /**
   * Get all storage data for the channel
   */
  async getAll(): Promise<StorageResponse> {
    return this.emitWithAck("metadata:getChannel", {
      channelName: this.channelName,
      channelType: this.channelType,
    });
  }

  /**
   * Set multiple storage values (batch operation)
   */
  async setMany(items: Partial<TSchema>, options?: StorageOptions): Promise<StorageResponse> {
    const data: StorageItem[] = Object.entries(items).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

    return this.emitWithAck("metadata:setChannel", {
      channelName: this.channelName,
      channelType: this.channelType,
      data,
      options,
    });
  }

  /**
   * Update multiple storage values (incremental)
   */
  async updateMany(items: Partial<TSchema>, options?: StorageOptions): Promise<StorageResponse> {
    const data: StorageItem[] = Object.entries(items).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

    return this.emitWithAck("metadata:updateChannel", {
      channelName: this.channelName,
      channelType: this.channelType,
      data,
      options,
    });
  }

  /**
   * Remove multiple storage keys
   */
  async removeMany(keys: Array<keyof TSchema>, options?: StorageOptions): Promise<StorageResponse> {
    const data: StorageItem[] = keys.map((key) => ({ key: key as string }));

    return this.emitWithAck("metadata:removeChannel", {
      channelName: this.channelName,
      channelType: this.channelType,
      data,
      options,
    });
  }

  /**
   * Clear all storage data for the channel
   */
  async clear(options?: StorageOptions): Promise<StorageResponse> {
    return this.emitWithAck("metadata:removeChannel", {
      channelName: this.channelName,
      channelType: this.channelType,
      options,
    });
  }

  /**
   * Execute a callback with automatic lock management
   * @experimental
   */
  async withLock<T>(
    callback: (storage: this) => Promise<T>,
    options?: LockOptions
  ): Promise<T> {
    // TODO: Implement automatic lock management
    // For now, just execute the callback
    this.logger.warn("withLock is not yet fully implemented, executing without lock");
    return callback(this);
  }

  private attachListener(): void {
    if (this.listenerAttached) {
      return;
    }
    this.socket.on(this.metadataEventName, this.handleStorageEvent);
    this.listenerAttached = true;
  }

  private detachListener(): void {
    if (!this.listenerAttached) {
      return;
    }
    this.socket.off(this.metadataEventName, this.handleStorageEvent);
    this.listenerAttached = false;
  }

  private handleStorageEvent = (payload: StorageEvent): void => {
    // Only handle events for this channel
    if (payload.channelName !== this.channelName) {
      return;
    }

    this.logger.debug("storage:event", payload);

    if (payload.operation === "set" || payload.operation === "update") {
      this.emit("updated", payload);
    } else if (payload.operation === "remove") {
      this.emit("removed", payload);
    }
  };

  private emitWithAck(eventName: string, payload: unknown): Promise<StorageResponse> {
    return new Promise<StorageResponse>((resolve, reject) => {
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new StorageError(String(error)));
      };

      const cleanup = () => {
        this.socket.off("error", onError);
      };

      this.socket.emit(eventName, payload, (ack: StorageAck) => {
        cleanup();
        if (!ack) {
          const error = new StorageError("Malformed acknowledgement from server");
          this.logger.error("storage ack malformed", { eventName });
          reject(error);
          return;
        }

        if (!ack.ok) {
          const mapped = this.mapError(ack.error, ack.code);
          this.logger.warn("storage operation failed", {
            eventName,
            code: ack.code,
            error: ack.error,
          });
          reject(mapped);
          return;
        }

        resolve(this.extractResponse(ack));
      });

      this.socket.once("error", onError);
    });
  }

  private extractResponse(ack: StorageAckSuccess): StorageResponse {
    if ("data" in ack && ack.data) {
      return ack.data;
    }
    const { ok: _ok, ...inline } = ack as StorageAckSuccessInline;
    return inline as StorageResponse;
  }

  private mapError(message: string, code?: string): Error {
    switch (code) {
      case "METADATA_CONFLICT":
        return new StorageConflictError(message);
      case "METADATA_LOCK":
        return new StorageLockError(message);
      case "METADATA_INVALID":
        return new StorageValidationError(message);
      default:
        return new StorageError(message);
    }
  }
}
