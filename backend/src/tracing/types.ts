import type { Span, Context } from "@opentelemetry/api";

/**
 * Tracing configuration options
 */
export interface TracingConfig {
  /**
   * Service name for tracing
   * @default "realtime-presence-service"
   */
  serviceName?: string;

  /**
   * Service version
   */
  version?: string;

  /**
   * Environment (development, staging, production)
   */
  environment?: string;

  /**
   * Enable tracing
   * @default true
   */
  enabled?: boolean;

  /**
   * Sampling rate (0.0 to 1.0)
   * @default 1.0 (100% sampling)
   */
  samplingRate?: number;

  /**
   * OTLP exporter endpoint
   * @default "http://localhost:4318"
   */
  otlpEndpoint?: string;

  /**
   * Export to console for debugging
   * @default false
   */
  consoleExport?: boolean;

  /**
   * Enable metrics collection
   * @default true
   */
  enableMetrics?: boolean;

  /**
   * Metrics export interval in milliseconds
   * @default 60000 (1 minute)
   */
  metricsExportIntervalMs?: number;

  /**
   * Enable Redis instrumentation
   * @default true
   */
  enableRedisInstrumentation?: boolean;
}

/**
 * Trace context stored in socket.data
 */
export interface TraceContext {
  /**
   * Current span
   */
  span?: Span;

  /**
   * OpenTelemetry context
   */
  context?: Context;

  /**
   * Trace ID for correlation
   */
  traceId?: string;

  /**
   * Span ID
   */
  spanId?: string;

  /**
   * Custom attributes
   */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Trace span attributes for presence operations
 */
export interface PresenceSpanAttributes {
  "presence.operation": "join" | "heartbeat" | "leave" | "reap";
  "presence.room_id"?: string;
  "presence.user_id"?: string;
  "presence.conn_id"?: string;
  "presence.epoch"?: number;
  "presence.state_changed"?: boolean;
}

/**
 * Trace span attributes for metadata operations
 */
export interface MetadataSpanAttributes {
  "metadata.operation": "set" | "update" | "remove" | "get";
  "metadata.channel_type"?: string;
  "metadata.channel_name"?: string;
  "metadata.item_count"?: number;
  "metadata.major_revision"?: number;
}

/**
 * Trace span attributes for Redis operations
 */
export interface RedisSpanAttributes {
  "redis.command": string;
  "redis.key"?: string;
  "redis.args_count"?: number;
  "redis.latency_ms"?: number;
  "redis.error"?: string;
}

/**
 * Metrics collected by the tracing system
 */
export interface TracingMetrics {
  /**
   * Total number of active connections
   */
  "presence.connections.active": number;

  /**
   * Total number of active rooms
   */
  "presence.rooms.active": number;

  /**
   * Operation duration histogram
   */
  "presence.operation.duration": number;

  /**
   * Operation success/failure counter
   */
  "presence.operation.result": number;

  /**
   * Redis command duration
   */
  "redis.command.duration": number;

  /**
   * Heartbeat latency
   */
  "presence.heartbeat.latency": number;
}
