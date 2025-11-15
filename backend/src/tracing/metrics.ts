/**
 * Metrics Collection
 *
 * Custom metrics for presence service monitoring:
 * - Active connections and rooms
 * - Operation latencies
 * - Success/failure rates
 * - Redis performance
 */

import { metrics, type Counter, type Histogram, type ObservableGauge } from "@opentelemetry/api";
import type { Redis } from "ioredis";
import { activeRoomsKey } from "../presence/keys";

export class PresenceMetrics {
  private readonly meter = metrics.getMeter("realtime-presence-service");

  // Counters
  private readonly operationCounter: Counter;
  private readonly errorCounter: Counter;
  private readonly eventCounter: Counter;

  // Histograms (for latency tracking)
  private readonly operationDuration: Histogram;
  private readonly redisDuration: Histogram;
  private readonly heartbeatLatency: Histogram;

  // Observable Gauges (for real-time metrics)
  private activeConnectionsGauge: ObservableGauge | null = null;
  private activeRoomsGauge: ObservableGauge | null = null;

  constructor(private readonly redis?: Redis) {
    // Initialize counters
    this.operationCounter = this.meter.createCounter("presence.operation.total", {
      description: "Total number of presence operations",
    });

    this.errorCounter = this.meter.createCounter("presence.error.total", {
      description: "Total number of errors",
    });

    this.eventCounter = this.meter.createCounter("presence.event.total", {
      description: "Total number of presence events published",
    });

    // Initialize histograms
    this.operationDuration = this.meter.createHistogram("presence.operation.duration", {
      description: "Duration of presence operations in milliseconds",
      unit: "ms",
    });

    this.redisDuration = this.meter.createHistogram("redis.command.duration", {
      description: "Duration of Redis commands in milliseconds",
      unit: "ms",
    });

    this.heartbeatLatency = this.meter.createHistogram("presence.heartbeat.latency", {
      description: "Heartbeat processing latency in milliseconds",
      unit: "ms",
    });

    // Initialize observable gauges if Redis is available
    if (this.redis) {
      this.initializeGauges();
    }
  }

  /**
   * Initialize observable gauges for real-time metrics
   */
  private initializeGauges(): void {
    // Active rooms count
    this.activeRoomsGauge = this.meter.createObservableGauge("presence.rooms.active", {
      description: "Number of active presence rooms",
    });

    this.activeRoomsGauge.addCallback(async (observable) => {
      try {
        const count = await this.redis!.scard(activeRoomsKey());
        observable.observe(count);
      } catch (error) {
        // Silently fail - metrics should not break the application
      }
    });

    // TODO: Add active connections gauge
    // This would require tracking connections in Redis or in-memory
  }

  /**
   * Record a presence operation
   */
  recordOperation(
    operation: "join" | "heartbeat" | "leave" | "reap",
    attributes: Record<string, string> = {}
  ): void {
    this.operationCounter.add(1, {
      operation,
      ...attributes,
    });
  }

  /**
   * Record operation duration
   */
  recordOperationDuration(
    operation: "join" | "heartbeat" | "leave" | "reap",
    durationMs: number,
    attributes: Record<string, string> = {}
  ): void {
    this.operationDuration.record(durationMs, {
      operation,
      ...attributes,
    });
  }

  /**
   * Record an error
   */
  recordError(
    operation: string,
    errorType: string,
    attributes: Record<string, string> = {}
  ): void {
    this.errorCounter.add(1, {
      operation,
      error_type: errorType,
      ...attributes,
    });
  }

  /**
   * Record a presence event
   */
  recordEvent(
    eventType: "join" | "leave" | "update",
    attributes: Record<string, string> = {}
  ): void {
    this.eventCounter.add(1, {
      event_type: eventType,
      ...attributes,
    });
  }

  /**
   * Record Redis command duration
   */
  recordRedisDuration(command: string, durationMs: number): void {
    this.redisDuration.record(durationMs, {
      command: command.toLowerCase(),
    });
  }

  /**
   * Record heartbeat latency
   */
  recordHeartbeatLatency(latencyMs: number, attributes: Record<string, string> = {}): void {
    this.heartbeatLatency.record(latencyMs, attributes);
  }

  /**
   * Helper to measure and record operation duration
   */
  async measureOperation<T>(
    operation: "join" | "heartbeat" | "leave" | "reap",
    fn: () => Promise<T>,
    attributes: Record<string, string> = {}
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      this.recordOperation(operation, { ...attributes, result: "success" });
      this.recordOperationDuration(operation, duration, attributes);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      this.recordOperation(operation, { ...attributes, result: "error" });
      this.recordOperationDuration(operation, duration, attributes);
      this.recordError(operation, error instanceof Error ? error.name : "UnknownError", attributes);

      throw error;
    }
  }
}

/**
 * Create a global metrics instance
 */
let globalMetrics: PresenceMetrics | null = null;

export function createMetrics(redis?: Redis): PresenceMetrics {
  if (!globalMetrics) {
    globalMetrics = new PresenceMetrics(redis);
  }
  return globalMetrics;
}

export function getMetrics(): PresenceMetrics | null {
  return globalMetrics;
}
