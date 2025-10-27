import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

import { RealtimeServer, createPresenceModule } from "../../src";
import { createChatModule } from "./chat-module";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const pubClient = new Redis("redis://localhost:6379");
const subClient = new Redis("redis://localhost:6379");
const redis = new Redis("redis://localhost:6379");

io.adapter(createAdapter(pubClient, subClient));

const server = new RealtimeServer({ io, redis });

server.use(
  createPresenceModule({
    ttlMs: 30_000,
    reaperIntervalMs: 3_000,
    reaperLookbackMs: 60_000,
  })
);

server.use(
  createChatModule({
    maxHistory: 100,
  })
);

server.start().catch((error) => {
  console.error("Failed to start realtime server", error);
  process.exit(1);
});

const port = 3000;
httpServer.listen(port, () => {
  console.log(`Realtime message server with chat module listening on port ${port}`);
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
