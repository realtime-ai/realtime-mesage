/**
 * Simplest traced server example
 *
 * This shows the minimal code needed to enable tracing.
 * All configuration uses smart defaults.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { initTracing } from "../src/tracing/setup";
import { createSocketTraceMiddleware } from "../src/tracing/socket-middleware";
import { initPresence } from "../src/presence-server";

// ✨ Step 1: Enable tracing (with all defaults)
initTracing();

// Step 2: Create server and Socket.IO
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

// Step 3: Setup Redis
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const pubClient = new Redis(redisUrl);
const subClient = new Redis(redisUrl);
const redis = new Redis(redisUrl);

io.adapter(createAdapter(pubClient, subClient));

// ✨ Step 4: Add tracing middleware
createSocketTraceMiddleware(io);

// Step 5: Initialize presence service
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
    console.log("✅ Presence service initialized with tracing");
  })
  .catch((error) => {
    console.error("Failed to start presence services", error);
    process.exit(1);
  });

// Step 6: Start server
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
  console.log(`📊 Jaeger UI: http://localhost:16686`);
  console.log(`📈 Grafana: http://localhost:3001`);
});

// Graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("Shutting down...");
  if (presenceRuntime) await presenceRuntime.dispose();
  await Promise.all([pubClient.quit(), subClient.quit(), redis.quit()]);
  httpServer.close(() => process.exit(0));
}
