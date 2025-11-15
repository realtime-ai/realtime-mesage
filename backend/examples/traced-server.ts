/**
 * Example: Presence Server with Distributed Tracing
 *
 * This example demonstrates how to set up the presence server with
 * OpenTelemetry tracing and metrics enabled.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

// Initialize tracing FIRST, before any other imports
import { initTracing } from "../src/tracing/setup";
import { createSocketTraceMiddleware } from "../src/tracing/socket-middleware";
import { createMetrics } from "../src/tracing/metrics";
import { initPresence } from "../src/presence-server";
import type { PresenceRuntime } from "../src/presence-server";

// Configure tracing
initTracing({
  serviceName: "realtime-presence-service",
  version: "1.0.0",
  environment: process.env.NODE_ENV || "development",
  enabled: true,
  samplingRate: 1.0, // 100% sampling for development
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
  consoleExport: process.env.NODE_ENV === "development", // Console export in dev mode
  enableMetrics: true,
  metricsExportIntervalMs: 60000, // Export metrics every minute
  enableRedisInstrumentation: true,
});

// Create HTTP server and Socket.IO
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Setup Redis clients
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const pubClient = new Redis(redisUrl);
const subClient = new Redis(redisUrl);
const redis = new Redis(redisUrl);

// Setup Socket.IO Redis adapter
io.adapter(createAdapter(pubClient, subClient));

// Add Socket.IO tracing middleware
createSocketTraceMiddleware(io, "realtime-presence-service");

// Initialize metrics
const metrics = createMetrics(redis);

let presenceRuntime: PresenceRuntime | null = null;

// Initialize presence service
initPresence({
  io,
  redis,
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
  logger: {
    debug: (message: string, meta?: unknown) => {
      console.debug(message, meta ?? "");
    },
    info: (message: string, meta?: unknown) => {
      console.log(message, meta ?? "");
    },
    warn: (message: string, meta?: unknown) => {
      console.warn(message, meta ?? "");
    },
    error: (message: string, meta?: unknown) => {
      console.error(message, meta ?? "");
    },
  },
  // Enable optimizations
  optimizations: {
    enableHeartbeatBatching: true,
    heartbeatBatchWindowMs: 50,
    heartbeatMaxBatchSize: 100,
    enableLuaHeartbeat: false, // Can enable for even better performance
    enableTransactionalMetadata: false,
  },
})
  .then((runtime) => {
    presenceRuntime = runtime;
    console.log("Presence service initialized with tracing enabled");
  })
  .catch((error) => {
    console.error("Failed to start presence services", error);
    process.exit(1);
  });

// Start server
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Realtime message server listening on port ${port}`);
  console.log("Tracing enabled - send traces to OTLP collector");
  console.log(`OTLP endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"}`);
  console.log("\nView traces at:");
  console.log("  - Jaeger UI: http://localhost:16686");
  console.log("  - Zipkin UI: http://localhost:9411");
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await shutdown();
});

process.on("SIGTERM", async () => {
  await shutdown();
});

async function shutdown() {
  console.log("Shutting down realtime message server...");

  // Dispose presence runtime
  if (presenceRuntime) {
    await presenceRuntime.dispose();
    presenceRuntime = null;
  }

  // Close Redis clients
  await Promise.all([pubClient.quit(), subClient.quit(), redis.quit()]);

  // Close HTTP server
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Note: OpenTelemetry SDK shutdown is handled automatically via SIGTERM handler
}
