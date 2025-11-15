/**
 * Redis Instrumentation Helpers
 *
 * Additional Redis instrumentation beyond what IORedisInstrumentation provides.
 * Tracks custom metrics and patterns specific to the presence service.
 */

import type { Redis } from "ioredis";
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { RedisSpanAttributes } from "./types";

/**
 * Create instrumented Redis client wrapper
 * This wraps Redis commands with additional tracing context
 */
export function createRedisInstrumentation(
  redis: Redis,
  serviceName = "realtime-presence-service"
) {
  const tracer = trace.getTracer(serviceName);

  return {
    /**
     * Execute a Redis command with tracing
     */
    async execute<T>(
      command: string,
      fn: () => Promise<T>,
      attributes: Partial<RedisSpanAttributes> = {}
    ): Promise<T> {
      const span = tracer.startSpan(`redis.${command.toLowerCase()}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "redis",
          "redis.command": command,
          ...attributes,
        },
      });

      const startTime = Date.now();

      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const result = await fn();

          const latency = Date.now() - startTime;
          span.setAttribute("redis.latency_ms", latency);
          span.setStatus({ code: SpanStatusCode.OK });

          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Redis error",
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Trace a Redis pipeline execution
     */
    async tracePipeline<T>(
      pipelineName: string,
      commandCount: number,
      fn: () => Promise<T>
    ): Promise<T> {
      const span = tracer.startSpan(`redis.pipeline.${pipelineName}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "redis",
          "redis.pipeline": pipelineName,
          "redis.command_count": commandCount,
        },
      });

      const startTime = Date.now();

      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const result = await fn();

          const latency = Date.now() - startTime;
          span.setAttribute("redis.latency_ms", latency);
          span.setStatus({ code: SpanStatusCode.OK });

          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Pipeline error",
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      });
    },

    /**
     * Add custom monitoring for specific key patterns
     */
    monitorKeyPattern(pattern: string, operation: "read" | "write") {
      const span = trace.getActiveSpan();
      if (span) {
        span.setAttributes({
          "redis.key_pattern": pattern,
          "redis.operation_type": operation,
        });
      }
    },
  };
}

/**
 * Monitor Redis pub/sub operations
 */
export function instrumentRedisPubSub(redis: Redis, serviceName = "realtime-presence-service") {
  const tracer = trace.getTracer(serviceName);

  // Wrap publish operations
  const originalPublish = redis.publish.bind(redis);
  redis.publish = async function (channel: string, message: string) {
    const span = tracer.startSpan("redis.publish", {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "redis",
        "messaging.destination": channel,
        "messaging.message_payload_size_bytes": Buffer.byteLength(message),
      },
    });

    try {
      const result = await originalPublish(channel, message);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Publish error",
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  };

  return redis;
}
