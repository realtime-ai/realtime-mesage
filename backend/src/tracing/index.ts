/**
 * OpenTelemetry Tracing and Metrics Setup
 *
 * This module provides distributed tracing and metrics collection for the realtime presence service.
 * It instruments Socket.IO events, presence operations, and Redis commands.
 */

export { initTracing } from "./setup";
export { TraceService } from "./trace-service";
export { createSocketTraceMiddleware } from "./socket-middleware";
export { createRedisInstrumentation } from "./redis-instrumentation";
export type { TracingConfig, TraceContext } from "./types";
