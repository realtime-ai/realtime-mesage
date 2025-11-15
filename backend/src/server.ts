import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

import { config } from "./config";
import { initPresence } from "./presence-server";
import type { PresenceRuntime } from "./presence-server";

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

let presenceRuntime: PresenceRuntime | null = null;

initPresence({
  io,
  redis,
  ttlMs: config.presenceTtlMs,
  reaperIntervalMs: config.reaperIntervalMs,
  reaperLookbackMs: config.reaperLookbackMs,
})
  .then((runtime) => {
    presenceRuntime = runtime;
  })
  .catch((error) => {
    console.error("Failed to start presence services", error);
    process.exit(1);
  });

const port = config.port;
httpServer.listen(port, () => {
  console.log(`Realtime message server listening on port ${port}`);
});

process.on("SIGINT", async () => {
  await shutdown();
});

process.on("SIGTERM", async () => {
  await shutdown();
});

async function shutdown() {
  console.log("Shutting down realtime message server...");
  if (presenceRuntime) {
    await presenceRuntime.dispose();
    presenceRuntime = null;
  }
  await Promise.all([pubClient.quit(), subClient.quit(), redis.quit()]);
  httpServer.close(() => {
    process.exit(0);
  });
}
