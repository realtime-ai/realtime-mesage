import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

import { config } from "../src/config";
import { initPresence, type PresenceRuntime } from "../src";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const pubClient = new Redis(config.redisUrl);
const subClient = new Redis(config.redisUrl);
const redis = new Redis(config.redisUrl);

io.adapter(createAdapter(pubClient, subClient));

let presence: PresenceRuntime | null = null;

async function start() {
  try {
    presence = await initPresence({
      io,
      redis,
      ttlMs: config.presenceTtlMs,
      reaperIntervalMs: config.reaperIntervalMs,
      reaperLookbackMs: config.reaperLookbackMs,
    });
  } catch (error) {
    console.error("Failed to initialize presence services", error);
    process.exit(1);
  }

  const port = config.port;
  httpServer.listen(port, () => {
    console.log(`Presence server listening on port ${port}`);
  });
}

async function shutdown() {
  console.log("Shutting down presence server...");
  if (presence) {
    await presence.dispose();
    presence = null;
  }
  await Promise.all([pubClient.quit(), subClient.quit(), redis.quit()]);
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  console.error("Presence server startup failed", error);
  process.exit(1);
});

