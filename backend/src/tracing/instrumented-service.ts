/**
 * Example: Instrumented Presence Service
 *
 * This file demonstrates how to add tracing to the PresenceService.
 * You can either extend PresenceService or wrap its methods.
 */

import type { Redis } from "ioredis";
import { PresenceService, type PresenceServiceOptions } from "../presence/service";
import type {
  JoinOptions,
  HeartbeatOptions,
  PresenceSnapshotEntry,
} from "../presence/types";
import { TraceService } from "./trace-service";
import { PresenceMetrics } from "./metrics";

/**
 * Instrumented wrapper for PresenceService
 * Adds distributed tracing and metrics to all operations
 */
export class InstrumentedPresenceService extends PresenceService {
  private readonly traceService: TraceService;
  private readonly metrics: PresenceMetrics;

  constructor(
    redis: Redis,
    options: PresenceServiceOptions,
    serviceName = "realtime-presence-service"
  ) {
    super(redis, options);
    this.traceService = new TraceService(serviceName);
    this.metrics = new PresenceMetrics(redis);
  }

  /**
   * Instrumented join operation
   */
  async join(options: JoinOptions): Promise<PresenceSnapshotEntry[]> {
    return this.traceService.tracePresenceOperation(
      "join",
      {
        "presence.operation": "join",
        "presence.room_id": options.roomId,
        "presence.user_id": options.userId,
        "presence.conn_id": options.connId,
      },
      async (span) => {
        return this.metrics.measureOperation("join", async () => {
          const result = await super.join(options);

          // Add result metadata to span
          span.setAttribute("presence.snapshot_size", result.length);
          this.traceService.addEvent("presence.joined", {
            room_id: options.roomId,
            user_id: options.userId,
            member_count: result.length,
          });

          return result;
        });
      }
    );
  }

  /**
   * Instrumented heartbeat operation
   */
  async heartbeat(options: HeartbeatOptions): Promise<boolean> {
    return this.traceService.tracePresenceOperation(
      "heartbeat",
      {
        "presence.operation": "heartbeat",
        "presence.conn_id": options.connId,
        "presence.epoch": options.epoch,
      },
      async (span) => {
        return this.metrics.measureOperation("heartbeat", async () => {
          const result = await super.heartbeat(options);

          span.setAttribute("presence.state_changed", result);

          if (options.patchState) {
            this.traceService.addEvent("presence.state_updated", {
              conn_id: options.connId,
              changed: result,
            });
          }

          return result;
        });
      }
    );
  }

  /**
   * Instrumented leave operation
   */
  async leave(connId: string): Promise<{ roomId: string; userId: string } | null> {
    return this.traceService.tracePresenceOperation(
      "leave",
      {
        "presence.operation": "leave",
        "presence.conn_id": connId,
      },
      async (span) => {
        return this.metrics.measureOperation("leave", async () => {
          const result = await super.leave(connId);

          if (result) {
            span.setAttributes({
              "presence.room_id": result.roomId,
              "presence.user_id": result.userId,
            });
            this.traceService.addEvent("presence.left", {
              room_id: result.roomId,
              user_id: result.userId,
            });
          } else {
            span.setAttribute("presence.not_found", true);
          }

          return result;
        });
      }
    );
  }

  /**
   * Instrumented snapshot fetch
   */
  async fetchRoomSnapshot(roomId: string): Promise<PresenceSnapshotEntry[]> {
    const span = this.traceService.createPresenceSpan("reap", {
      "presence.operation": "reap",
      "presence.room_id": roomId,
    });

    return this.traceService.withSpan(span, async () => {
      const result = await super.fetchRoomSnapshot(roomId);
      span.setAttribute("presence.snapshot_size", result.length);
      return result;
    });
  }
}

/**
 * Helper function to wrap an existing PresenceService instance with tracing
 * Use this if you don't want to change your existing code
 */
export function wrapPresenceServiceWithTracing(
  service: PresenceService,
  serviceName = "realtime-presence-service"
): PresenceService {
  const traceService = new TraceService(serviceName);
  const metrics = new PresenceMetrics();

  // Wrap join
  const originalJoin = service.join.bind(service);
  service.join = async (options: JoinOptions) => {
    return traceService.tracePresenceOperation(
      "join",
      {
        "presence.operation": "join",
        "presence.room_id": options.roomId,
        "presence.user_id": options.userId,
        "presence.conn_id": options.connId,
      },
      async (span) => {
        return metrics.measureOperation("join", async () => {
          const result = await originalJoin(options);
          span.setAttribute("presence.snapshot_size", result.length);
          return result;
        });
      }
    );
  };

  // Wrap heartbeat
  const originalHeartbeat = service.heartbeat.bind(service);
  service.heartbeat = async (options: HeartbeatOptions) => {
    return traceService.tracePresenceOperation(
      "heartbeat",
      {
        "presence.operation": "heartbeat",
        "presence.conn_id": options.connId,
      },
      async (span) => {
        return metrics.measureOperation("heartbeat", async () => {
          const result = await originalHeartbeat(options);
          span.setAttribute("presence.state_changed", result);
          return result;
        });
      }
    );
  };

  // Wrap leave
  const originalLeave = service.leave.bind(service);
  service.leave = async (connId: string) => {
    return traceService.tracePresenceOperation(
      "leave",
      {
        "presence.operation": "leave",
        "presence.conn_id": connId,
      },
      async (span) => {
        return metrics.measureOperation("leave", async () => {
          const result = await originalLeave(connId);
          if (result) {
            span.setAttributes({
              "presence.room_id": result.roomId,
              "presence.user_id": result.userId,
            });
          }
          return result;
        });
      }
    );
  };

  return service;
}
