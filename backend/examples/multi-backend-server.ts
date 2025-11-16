/**
 * Example: Using different tracing backends
 *
 * This example shows how to use various tracing backends
 * by simply changing environment variables.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import { Redis } from "ioredis";
import { initTracing } from "../src/tracing/setup";
import { createSocketTraceMiddleware } from "../src/tracing/socket-middleware";
import { initPresence } from "../src/presence-server";

// ✨ Auto-detect and use the configured backend
// Priority:
// 1. SigNoz Cloud (if SIGNOZ_ACCESS_TOKEN is set)
// 2. Grafana Cloud (if GRAFANA_INSTANCE_ID is set)
// 3. Honeycomb (if HONEYCOMB_API_KEY is set)
// 4. New Relic (if NEW_RELIC_LICENSE_KEY is set)
// 5. Local Jaeger (default)

initTracing();

console.log("\n🎯 Tracing Backend Detection:");
if (process.env.SIGNOZ_ACCESS_TOKEN) {
  console.log("✅ Using: SigNoz Cloud");
  console.log(`   Dashboard: https://signoz.io/`);
} else if (process.env.GRAFANA_INSTANCE_ID) {
  console.log("✅ Using: Grafana Cloud");
  console.log(`   Dashboard: https://grafana.com/`);
} else if (process.env.HONEYCOMB_API_KEY) {
  console.log("✅ Using: Honeycomb");
  console.log(`   Dashboard: https://ui.honeycomb.io/`);
} else if (process.env.NEW_RELIC_LICENSE_KEY) {
  console.log("✅ Using: New Relic");
  console.log(`   Dashboard: https://one.newrelic.com/`);
} else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.log("✅ Using: Custom OTLP Endpoint");
  console.log(`   Endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
} else {
  console.log("✅ Using: Local Jaeger");
  console.log(`   Dashboard: http://localhost:16686`);
}
console.log("");

// Create server
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

// Setup Redis
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// Add tracing middleware
createSocketTraceMiddleware(io);

// Initialize presence
let presenceRuntime: any = null;

initPresence({
  io,
  redis,
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
})
  .then((runtime) => {
    presenceRuntime = runtime;
    console.log("✅ Presence service initialized");
  })
  .catch((error) => {
    console.error("Failed to start presence services", error);
    process.exit(1);
  });

// Start server
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`\n🚀 Server listening on port ${port}`);
  console.log("📊 Traces are being sent to the configured backend\n");
});

// Graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("\nShutting down...");
  if (presenceRuntime) await presenceRuntime.dispose();
  await redis.quit();
  httpServer.close(() => process.exit(0));
}
