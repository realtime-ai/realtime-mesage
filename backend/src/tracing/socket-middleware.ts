/**
 * Socket.IO Trace Middleware
 *
 * Automatically creates spans for Socket.IO events and propagates trace context.
 */

import type { Server, Socket } from "socket.io";
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { TraceContext } from "./types";

/**
 * Create Socket.IO middleware for tracing
 */
export function createSocketTraceMiddleware(server: Server, serviceName = "realtime-presence-service"): void {
  const tracer = trace.getTracer(serviceName);

  // Middleware for connection-level tracing
  server.use((socket: Socket, next) => {
    // Create a span for the socket connection
    const connectionSpan = tracer.startSpan("socket.connection", {
      kind: SpanKind.SERVER,
      attributes: {
        "socket.id": socket.id,
        "socket.transport": socket.conn.transport.name,
        "client.address": socket.handshake.address,
      },
    });

    // Store trace context in socket data
    const traceContext: TraceContext = {
      span: connectionSpan,
      context: trace.setSpan(context.active(), connectionSpan),
      traceId: connectionSpan.spanContext().traceId,
      spanId: connectionSpan.spanContext().spanId,
    };
    socket.data.traceContext = traceContext;

    // Add connection attributes to span when available
    socket.on("presence:join", (data) => {
      if (data?.roomId) {
        connectionSpan.setAttribute("presence.room_id", data.roomId);
      }
      if (data?.userId) {
        connectionSpan.setAttribute("presence.user_id", data.userId);
      }
    });

    // End connection span on disconnect
    socket.on("disconnect", (reason) => {
      connectionSpan.setAttribute("disconnect.reason", reason);
      connectionSpan.setStatus({ code: SpanStatusCode.OK });
      connectionSpan.end();
    });

    next();
  });

  // Wrap event handlers with tracing
  instrumentSocketEvents(server, serviceName);
}

/**
 * Instrument Socket.IO events with automatic span creation
 */
function instrumentSocketEvents(server: Server, serviceName: string): void {
  const tracer = trace.getTracer(serviceName);
  const eventsToTrace = [
    "presence:join",
    "presence:heartbeat",
    "presence:leave",
    "metadata:setChannel",
    "metadata:updateChannel",
    "metadata:removeChannel",
    "metadata:getChannel",
  ];

  server.on("connection", (socket: Socket) => {
    eventsToTrace.forEach((eventName) => {
      const originalHandler = socket.listeners(eventName)[0];
      if (!originalHandler) {
        // Event handler will be registered later, wrap it when it's registered
        socket.prependAny((event: string, ...args) => {
          if (event === eventName) {
            wrapEventHandler(socket, eventName, tracer);
          }
        });
      }
    });
  });
}

/**
 * Wrap a single event handler with tracing
 */
function wrapEventHandler(socket: Socket, eventName: string, tracer: any): void {
  const listeners = socket.listeners(eventName);
  if (listeners.length === 0) {
    return;
  }

  // Remove all listeners
  socket.removeAllListeners(eventName);

  // Re-register with tracing wrapper
  listeners.forEach((listener) => {
    socket.on(eventName, async (...args: unknown[]) => {
      const parentContext = socket.data.traceContext?.context || context.active();

      return context.with(parentContext, async () => {
        const span = tracer.startSpan(`socket.event.${eventName}`, {
          kind: SpanKind.SERVER,
          attributes: {
            "socket.event": eventName,
            "socket.connection_id": socket.id,
          },
        });

        try {
          // Extract relevant data from payload for span attributes
          const payload = args[0];
          if (payload && typeof payload === "object") {
            addPayloadAttributes(span, payload as Record<string, unknown>);
          }

          // Call original handler
          const result = await listener.apply(socket, args);

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
    });
  });
}

/**
 * Add relevant payload attributes to span
 */
function addPayloadAttributes(span: any, payload: Record<string, unknown>): void {
  const safeAttributes: Record<string, string | number | boolean> = {};

  // Presence attributes
  if (payload.roomId && typeof payload.roomId === "string") {
    safeAttributes["presence.room_id"] = payload.roomId;
  }
  if (payload.userId && typeof payload.userId === "string") {
    safeAttributes["presence.user_id"] = payload.userId;
  }
  if (payload.connId && typeof payload.connId === "string") {
    safeAttributes["presence.conn_id"] = payload.connId;
  }
  if (payload.epoch && typeof payload.epoch === "number") {
    safeAttributes["presence.epoch"] = payload.epoch;
  }

  // Metadata attributes
  if (payload.channelType && typeof payload.channelType === "string") {
    safeAttributes["metadata.channel_type"] = payload.channelType;
  }
  if (payload.channelName && typeof payload.channelName === "string") {
    safeAttributes["metadata.channel_name"] = payload.channelName;
  }
  if (payload.data && Array.isArray(payload.data)) {
    safeAttributes["metadata.item_count"] = payload.data.length;
  }

  if (Object.keys(safeAttributes).length > 0) {
    span.setAttributes(safeAttributes);
  }
}
