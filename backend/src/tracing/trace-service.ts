/**
 * Trace Service
 *
 * High-level API for creating and managing traces in the presence service.
 * Provides convenience methods for instrumenting presence operations.
 */

import {
  trace,
  context,
  Span,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import type {
  PresenceSpanAttributes,
  MetadataSpanAttributes,
  RedisSpanAttributes,
} from "./types";

export class TraceService {
  private readonly tracer: Tracer;
  private readonly serviceName: string;

  constructor(serviceName = "realtime-presence-service") {
    this.serviceName = serviceName;
    this.tracer = trace.getTracer(serviceName);
  }

  /**
   * Create a new span for a presence operation
   */
  createPresenceSpan(
    operation: "join" | "heartbeat" | "leave" | "reap",
    attributes: Partial<PresenceSpanAttributes> = {}
  ): Span {
    const span = this.tracer.startSpan(`presence.${operation}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "presence.operation": operation,
        ...attributes,
      },
    });

    return span;
  }

  /**
   * Create a new span for a metadata operation
   */
  createMetadataSpan(
    operation: "set" | "update" | "remove" | "get",
    attributes: Partial<MetadataSpanAttributes> = {}
  ): Span {
    const span = this.tracer.startSpan(`metadata.${operation}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "metadata.operation": operation,
        ...attributes,
      },
    });

    return span;
  }

  /**
   * Create a new span for a Redis operation
   */
  createRedisSpan(command: string, attributes: Partial<RedisSpanAttributes> = {}): Span {
    const span = this.tracer.startSpan(`redis.${command.toLowerCase()}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "redis.command": command,
        "db.system": "redis",
        ...attributes,
      },
    });

    return span;
  }

  /**
   * Create a new span for Socket.IO event handling
   */
  createSocketEventSpan(eventName: string, connectionId: string): Span {
    const span = this.tracer.startSpan(`socket.${eventName}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "socket.event": eventName,
        "socket.connection_id": connectionId,
      },
    });

    return span;
  }

  /**
   * Execute a function within a span context
   */
  async withSpan<T>(
    span: Span,
    fn: (span: Span) => Promise<T> | T
  ): Promise<T> {
    const ctx = trace.setSpan(context.active(), span);

    return context.with(ctx, async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Execute a function with a new presence span
   */
  async tracePresenceOperation<T>(
    operation: "join" | "heartbeat" | "leave" | "reap",
    attributes: Partial<PresenceSpanAttributes>,
    fn: (span: Span) => Promise<T> | T
  ): Promise<T> {
    const span = this.createPresenceSpan(operation, attributes);
    return this.withSpan(span, fn);
  }

  /**
   * Execute a function with a new metadata span
   */
  async traceMetadataOperation<T>(
    operation: "set" | "update" | "remove" | "get",
    attributes: Partial<MetadataSpanAttributes>,
    fn: (span: Span) => Promise<T> | T
  ): Promise<T> {
    const span = this.createMetadataSpan(operation, attributes);
    return this.withSpan(span, fn);
  }

  /**
   * Add an event to the current active span
   */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent(name, attributes);
    }
  }

  /**
   * Set attributes on the current active span
   */
  setAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttributes(attributes);
    }
  }

  /**
   * Get the current active span
   */
  getActiveSpan(): Span | undefined {
    return trace.getActiveSpan();
  }

  /**
   * Get the current context
   */
  getContext(): Context {
    return context.active();
  }

  /**
   * Extract trace context for propagation (e.g., via Redis pub/sub)
   */
  extractTraceContext(): { traceId: string; spanId: string } | null {
    const span = trace.getActiveSpan();
    if (!span) {
      return null;
    }

    const spanContext = span.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    };
  }

  /**
   * Create a child span from trace context
   * Useful for continuing traces across pub/sub boundaries
   */
  continueTrace(
    traceContext: { traceId: string; spanId: string },
    spanName: string
  ): Span {
    // Create a new span that references the parent trace
    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.CONSUMER,
      attributes: {
        "parent.trace_id": traceContext.traceId,
        "parent.span_id": traceContext.spanId,
      },
    });

    return span;
  }

  /**
   * Measure execution time and record as span attribute
   */
  measureDuration<T>(
    fn: () => Promise<T> | T,
    attributeName = "duration_ms"
  ): Promise<T> {
    const startTime = Date.now();

    const recordDuration = () => {
      const duration = Date.now() - startTime;
      this.setAttributes({ [attributeName]: duration });
    };

    const result = fn();

    if (result instanceof Promise) {
      return result.finally(recordDuration);
    } else {
      recordDuration();
      return Promise.resolve(result);
    }
  }
}
