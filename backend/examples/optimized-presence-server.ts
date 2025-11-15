/**
 * 启用性能优化的 Presence 服务器示例
 * 
 * 演示如何启用心跳批处理、Lua 脚本和事务性 Metadata
 */

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
      
      // 启用性能优化特性
      optimizations: {
        // 心跳批处理：适合高并发场景
        enableHeartbeatBatching: true,
        heartbeatBatchWindowMs: 50,    // 50ms 批处理窗口
        heartbeatMaxBatchSize: 100,    // 最大批次 100 个请求

        // Lua 脚本：适合低延迟场景（与批处理互斥，Lua 优先）
        // enableLuaHeartbeat: true,

        // 事务性 Metadata：消除并发竞态
        enableTransactionalMetadata: true,
        metadataMaxRetries: 5,         // 冲突时最多重试 5 次
      },
    });

    console.log("✅ Presence service initialized with optimizations:");
    console.log("   - Heartbeat batching: enabled");
    console.log("   - Transactional metadata: enabled");

    // 监控批处理器状态（可选）
    const batcher = presence.getHeartbeatBatcher();
    if (batcher) {
      setInterval(() => {
        const bufferSize = batcher.getBufferSize();
        if (bufferSize > 0) {
          console.log(`📊 Heartbeat buffer size: ${bufferSize}`);
        }
      }, 5000);
    }
  } catch (error) {
    console.error("Failed to initialize presence services", error);
    process.exit(1);
  }

  const port = config.port;
  httpServer.listen(port, () => {
    console.log(`🚀 Optimized presence server listening on port ${port}`);
    console.log(`   Connect clients to: http://localhost:${port}`);
  });
}

async function shutdown() {
  console.log("Shutting down optimized presence server...");
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

