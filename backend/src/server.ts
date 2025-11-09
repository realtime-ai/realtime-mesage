import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

import { config } from "./config";
import { RealtimeServer } from "./core/realtime-server";
import { createPresenceModule } from "./modules/presence";

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

const server = new RealtimeServer({ io, redis });

server.use(
  createPresenceModule({
    ttlMs: config.presenceTtlMs,
    reaperIntervalMs: config.reaperIntervalMs,
    reaperLookbackMs: config.reaperLookbackMs,
  })
);

server.start().catch((error) => {
  console.error("Failed to start realtime server", error);
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
  await server.shutdown();
  await Promise.all([pubClient.quit(), subClient.quit(), redis.quit()]);
  httpServer.close(() => {
    process.exit(0);
  });
}
