import type { Span, Context } from "@opentelemetry/api";

/**
 * Tracing configuration options
 *
 * All options are optional with smart defaults.
 * Most users can just call initTracing() without any config.
 */
export interface TracingConfig {
  /**
   * Service name for tracing
   * @default process.env.OTEL_SERVICE_NAME || "realtime-presence-service"
   */
  serviceName?: string;

  /**
   * Service version
   * @default process.env.npm_package_version || "1.0.0"
   */
  version?: string;

  /**
   * Environment (development, staging, production)
   * @default process.env.NODE_ENV || "development"
   */
  environment?: string;

  /**
   * Enable tracing
   * @default process.env.OTEL_ENABLED !== "false" (enabled by default)
   */
  enabled?: boolean;

  /**
   * Sampling rate (0.0 to 1.0)
   * @default development: 1.0 (100%), production: 0.1 (10%)
   */
  samplingRate?: number;

  /**
   * OTLP exporter endpoint
   * @default process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"
   */
  otlpEndpoint?: string;

  /**
   * Export to console for debugging
   * @default true in development, false in production
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
