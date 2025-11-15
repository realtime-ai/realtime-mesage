# Server 使用文档

Realtime Message Server 是一个基于 Socket.IO 与 Redis 的在线状态（Presence）中枢。它将连接管理、心跳、跨节点事件广播以及频道元数据（Channel Metadata）封装成可复用的 `initPresence` 辅助函数与 `PresenceService` 类，适合嵌入任意 Node.js WebSocket 服务端。

## 目录速览

- `backend/src/index.ts` 暴露 `initPresence`、`PresenceService` 以及所有类型定义。
- `backend/src/presence-server.ts` 负责初始化 Redis、Socket.IO 适配器、事件桥与清理逻辑。
- `backend/src/presence/` 保存核心 Presence 与元数据实现。
- `backend/examples/presence-server.ts` 展示了最小可运行示例。
- `backend/docs/` 补充发布与 SDK 相关文档。

## 环境与依赖

- Node.js 18+
- Redis 6+（单实例或集群模式均可）
- 推荐安装 pnpm / npm 8+ 以使用 workspace 脚本

```bash
npm install
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/Socket.IO 监听端口 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接字符串（可为集群入口） |
| `PRESENCE_TTL_MS` | `30000` | 每个连接心跳超时时间（决定 reaper 的扫描窗口） |
| `PRESENCE_REAPER_INTERVAL_MS` | `3000` | 清理僵尸连接的执行频率 |
| `PRESENCE_REAPER_LOOKBACK_MS` | `2 * TTL` | 被视为失效连接的最小 last_seen 阈值 |

将上述变量写入 `.env` 或部署平台的 Secret 管理器即可。

### 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 使用 ts-node 启动开发服务器（watch 模式） |
| `npm run build` | 构建 `backend` 产物到 `dist/` |
| `npm start` | 运行已构建的服务器 |
| `npm run test:server` | 执行 Vitest 单元 + 集成测试 |
| `npm run benchmark:presence` | 运行高并发压测脚本 |

## 与现有 Socket.IO 服务集成

1. 创建 HTTP/HTTPS + Socket.IO 实例。
2. 初始化 Redis 客户端（推荐 `ioredis`，并按需复用 publish/subscribe 实例）。
3. 调用 `initPresence({ io, redis, ...options })`，它会：
   - 注册 `presence:join/heartbeat/leave` 事件处理；
   - 启动 Redis Pub/Sub 桥用于跨进程广播；
   - 拉起自动 reaper 以清理僵尸连接；
   - 返回 `PresenceRuntime`，用于优雅关闭。

```ts
import { createServer } from "http";
import { Server } from "socket.io";
import { Redis } from "ioredis";
import { initPresence } from "@YOUR_SCOPE/realtime-mesage";

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });
const redis = new Redis(process.env.REDIS_URL);

const presence = await initPresence({
  io,
  redis,
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
  logger: console,
});

httpServer.listen(3000);

process.on("SIGINT", async () => {
  await presence.dispose();
  await redis.quit();
  httpServer.close();
});
```

### 可选参数

- `ttlMs` / `reaperIntervalMs` / `reaperLookbackMs`：覆盖默认心跳策略。
- `logger`：注入自定义日志实现（需实现 `debug/info/warn/error`）。
- `bridge`：自定义 Presence 事件广播名称（默认 `presence:event` 与 `metadata:event`）。

## 横向扩展与 Redis 适配器

Socket.IO 在多实例部署时需要共享房间状态，建议开启 `@socket.io/redis-adapter`。示例（见 `backend/examples/presence-server.ts`）：

```ts
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

const pubClient = new Redis(config.redisUrl);
const subClient = new Redis(config.redisUrl);
io.adapter(createAdapter(pubClient, subClient));
```

Presence 层使用 Redis Pub/Sub（`room:<roomId>` channel），因此所有进程会同时收到 `presence:event` 与 `metadata:event`，无需额外消息总线。

## Presence 事件协议

| 事件 | 方向 | Payload | 说明 |
| --- | --- | --- | --- |
| `presence:join` | Client → Server | `{ roomId, userId, state? }` | 注册连接，返回 `{ ok, snapshot, self: { connId, epoch } }` |
| `presence:heartbeat` | Client → Server | `{ connId, epoch?, patchState? }` | 刷新 TTL，带增量状态将触发 `update` 广播 |
| `presence:leave` | Client → Server | `void` | 主动下线，清理 Redis 状态 |
| `presence:event` | Server → Room | `{ type: "join"|"update"|"leave", userId, connId, state, ts, epoch }` | 广播 Presence 生命周期 |
| `metadata:event` | Server → Room | `{ operation: "set"|"update"|"remove", channelName, channelType, items[], majorRevision }` | 当使用 Channel Metadata API 时推送增量 |

客户端 SDK 已封装上述事件；如需原生 Socket.IO 集成，请保持事件名称一致。

## Channel Metadata API

`PresenceService` 同样对外导出以便服务端执行频道元数据读写、并将结果广播给在同名 `roomId/channelName` 内的订阅者。

```ts
import { PresenceService } from "@YOUR_SCOPE/realtime-mesage";
import { Redis } from "ioredis";

const service = new PresenceService(new Redis(process.env.REDIS_URL), {
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
});

await service.setChannelMetadata({
  channelType: "room",
  channelName: "room-42",
  data: [{ key: "topic", value: "Weekly Sync" }],
  actorUserId: "user-123",
  options: { addTimestamp: true, addUserId: true },
});

const metadata = await service.getChannelMetadata({
  channelType: "room",
  channelName: "room-42",
});
```

可用方法：

- `setChannelMetadata`：整包替换，自动 bump major revision。
- `updateChannelMetadata`：基于 revision 进行部分更新，提供乐观锁。
- `removeChannelMetadata`：删除指定 key 或清空。
- `getChannelMetadata`：读取当前快照。

所有写操作都支持 `options.lockName` + `actorUserId` 来校验 Redis 分布式锁，错误码会映射为 `METADATA_CONFLICT / METADATA_LOCK / METADATA_INVALID`。

## 优雅关闭与健康检查

1. 捕获 `SIGINT/SIGTERM`，调用 `presence.dispose()` 以停止事件桥与 reaper。
2. `redis.quit()` 关闭连接；若使用了 `@socket.io/redis-adapter`，记得对 publish/subscribe 客户端也执行 `quit()`。
3. 在负载均衡之前添加 HTTP 健康检查（例如 `/healthz`），确认 Socket.IO 仍在监听并且 Redis 可达。

## Benchmark 与诊断

- `npm run benchmark:presence`：默认模拟 100 个房间、并发加入/心跳，可通过环境变量（`ROOM_COUNT`, `USERS_PER_ROOM`, `HEARTBEATS_PER_SEC` 等）调整。
- `npm run benchmark:sdk`：从客户端角度施压，验证心跳间隔与 ack 超时配置。
- `npm run test:e2e`：位于 `backend/src/e2e/` 的 Vitest 套件，包含元数据与 Presence 的端到端测试。

## 性能优化（可选）

### 启用优化特性

从 v1.1.0 开始，支持三项性能优化特性：

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    // 心跳批处理：提升 50-70% 吞吐量
    enableHeartbeatBatching: true,
    heartbeatBatchWindowMs: 50,
    heartbeatMaxBatchSize: 100,

    // Lua 脚本：降低 60-80% 延迟
    enableLuaHeartbeat: true,

    // 事务性 Metadata：消除并发竞态
    enableTransactionalMetadata: true,
    metadataMaxRetries: 5
  }
});
```

### 推荐配置

**高并发场景（100+ 连接）：**
```typescript
optimizations: {
  enableHeartbeatBatching: true,
  enableTransactionalMetadata: true
}
```

**低延迟场景（< 10ms）：**
```typescript
optimizations: {
  enableLuaHeartbeat: true,
  enableTransactionalMetadata: true
}
```

详见 [性能优化文档](./performance-optimizations.md)。

## 常见问题

- **无法连接 Redis**：确认 `REDIS_URL` 可被所有进程访问，必要时开启 TLS 并在连接串中添加 `?tls=true`。
- **Presence 状态不同步**：检查 `presence.event` 是否被意外重命名；集群部署需保证所有进程都调用 `initPresence`。
- **心跳提前过期**：适当调大 `PRESENCE_TTL_MS`，并确保客户端心跳间隔 `< ttlMs`；同步调整 `PRESENCE_REAPER_LOOKBACK_MS`。
- **Metadata 冲突频繁**：为写请求携带最新 `majorRevision` 与条目 `revision`，或在串行写场景中使用 `lockName`。启用 `enableTransactionalMetadata` 可自动处理冲突重试。

