import type { Socket } from "socket.io-client";
import { EventEmitter } from "../../core/event-emitter";
import type { Logger } from "../../core/types";
import type {
  ChannelMetadataEvent,
  ChannelMetadataEventMap,
  ChannelMetadataGetParams,
  ChannelMetadataMutationParams,
  ChannelMetadataRemovalParams,
  ChannelMetadataResponse,
} from "./types";

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

export class MetadataConflictError extends MetadataError {
  constructor(message: string) {
    super(message);
    this.name = "MetadataConflictError";
  }
}

export class MetadataLockError extends MetadataError {
  constructor(message: string) {
    super(message);
    this.name = "MetadataLockError";
  }
}

export class MetadataValidationError extends MetadataError {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

interface MetadataAckSuccessLegacy {
  ok: true;
  data: ChannelMetadataResponse;
}

interface MetadataAckSuccessInline extends ChannelMetadataResponse {
  ok: true;
}

type MetadataAckSuccess = MetadataAckSuccessLegacy | MetadataAckSuccessInline;

interface MetadataAckFailure {
  ok: false;
  error: string;
  code?: string;
}

type MetadataAck = MetadataAckSuccess | MetadataAckFailure;

export class ChannelMetadataClient extends EventEmitter<ChannelMetadataEventMap> {
  private readonly socket: Socket;
  private readonly logger: Logger;
  private readonly metadataEventName: string;
  private listenerAttached = false;

  constructor(socket: Socket, logger: Logger, metadataEventName = "metadata:event") {
    super();
    this.socket = socket;
    this.logger = logger;
    this.metadataEventName = metadataEventName;
    this.attachListener();
  }

  dispose(): void {
    this.detachListener();
    this.removeAll();
  }

  async setChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    return this.emitWithAck("metadata:setChannel", params);
  }

  async updateChannelMetadata(
    params: ChannelMetadataMutationParams
  ): Promise<ChannelMetadataResponse> {
    return this.emitWithAck("metadata:updateChannel", params);
  }

  async removeChannelMetadata(
    params: ChannelMetadataRemovalParams
  ): Promise<ChannelMetadataResponse> {
    return this.emitWithAck("metadata:removeChannel", params);
  }

  async getChannelMetadata(
    params: ChannelMetadataGetParams
  ): Promise<ChannelMetadataResponse> {
    return this.emitWithAck("metadata:getChannel", params);
  }

  onChannelEvent(handler: (event: ChannelMetadataEvent) => void): () => void {
    return this.on("metadataEvent", handler);
  }

  offChannelEvent(handler: (event: ChannelMetadataEvent) => void): void {
    this.off("metadataEvent", handler);
  }

  private attachListener(): void {
    if (this.listenerAttached) {
      return;
    }
    this.socket.on(this.metadataEventName, this.handleMetadataEvent);
    this.listenerAttached = true;
  }

  private detachListener(): void {
    if (!this.listenerAttached) {
      return;
    }
    this.socket.off(this.metadataEventName, this.handleMetadataEvent);
    this.listenerAttached = false;
  }

  private handleMetadataEvent = (payload: ChannelMetadataEvent): void => {
    this.logger.debug("metadata:event", payload);
    this.emit("metadataEvent", payload);
  };

  private emitWithAck(
    eventName: string,
    payload: unknown
  ): Promise<ChannelMetadataResponse> {
    return new Promise<ChannelMetadataResponse>((resolve, reject) => {
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new MetadataError(String(error)));
      };

      const cleanup = () => {
        this.socket.off("error", onError);
      };

      this.socket.emit(eventName, payload, (ack: MetadataAck) => {
        cleanup();
        if (!ack) {
          const error = new MetadataError("Malformed acknowledgement from server");
          this.logger.error("metadata ack malformed", { eventName });
          reject(error);
          return;
        }

        if (!ack.ok) {
          const mapped = this.mapError(ack.error, ack.code);
          this.logger.warn("metadata operation failed", {
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

  private extractResponse(ack: MetadataAckSuccess): ChannelMetadataResponse {
    if ("data" in ack && ack.data) {
      return ack.data;
    }
    const { ok: _ok, ...inline } = ack as MetadataAckSuccessInline;
    return inline as ChannelMetadataResponse;
  }

  private mapError(message: string, code?: string): Error {
    switch (code) {
      case "METADATA_CONFLICT":
        return new MetadataConflictError(message);
      case "METADATA_LOCK":
        return new MetadataLockError(message);
      case "METADATA_INVALID":
        return new MetadataValidationError(message);
      default:
        return new MetadataError(message);
    }
  }
}
