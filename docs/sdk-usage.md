# SDK 使用文档

Realtime Message SDK 是一个浏览器/Node 兼容的 TypeScript 客户端，封装了 Presence 生命周期、自动心跳、Socket.IO 自定义事件以及频道元数据（Channel Metadata）。本文帮助你在任意前端项目中快速落地。

## 功能概览

- `RealtimeClient`：负责 Socket.IO 连接、认证、重连与心跳调度。
- `PresenceChannel`：按房间维度管理成员快照、事件订阅与状态补丁。
- `ChannelMetadataClient`：对频道 Key-Value 进行 set/update/remove，并自动订阅服务端推送。
- 事件发射器范式：所有 API 都满足 `on/off/emit` 习惯用法。

## 安装

### 通过 npm 包

发布到 GitHub Packages 后即可安装：

```bash
npm install @YOUR_SCOPE/realtime-mesage-sdk
```

若使用私有 registry，请在 `.npmrc` 中配置：

```
@YOUR_SCOPE:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GH_TOKEN
```

### 本地开发/调试

```bash
npm install
npm run build:sdk        # 构建 dist/
npm run sdk:demo         # 运行 demo (http://localhost:4173)
```

Demo 会连接本地 `npm run dev` 启动的服务器，可实时验证 Presence 行为。

## 快速开始

```ts
import { RealtimeClient } from "@YOUR_SCOPE/realtime-mesage-sdk";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: () => ({ token: localStorage.getItem("auth") ?? "" }),
  presence: {
    heartbeatIntervalMs: 8_000,
    heartbeatAckTimeoutMs: 6_500,
    maxMissedHeartbeats: 2,
  },
});

await client.connect();

const { channel, response } = await client.joinRoom({
  roomId: "room-42",
  userId: "user-123",
  state: { mic: true, camera: false },
});

if (!response.ok) {
  throw new Error(response.error?.message ?? "join failed");
}

channel.on("snapshot", (members) => {
  console.table(members);
});

channel.on("presenceEvent", (event) => {
  console.log(event.type, event.userId, event.state);
});
```

### 退出与清理

```ts
await channel.leave();    // 停止心跳 + 离开房间
await client.disconnect();
```

## PresenceChannel API

- `join(params)` / `leave()` / `stop()`：加入、离开与销毁频道。
- `updateState(patch)`：触发一次带状态补丁的心跳。
- `sendHeartbeat(options)`：手动发送心跳（无需修改状态）。
- `emit(eventName, payload, ackOptions?)`：发送自定义 Socket.IO 事件，支持回调或 Promise ack。
- `on(event, handler)`：监听内置事件：
  - `connected`：加入房间后触发，返回 `{ connId, epoch }`
  - `snapshot`：当前成员初始列表（数组）
  - `presenceEvent`：`join | update | leave`
  - `heartbeatAck`：心跳确认（`{ ok, error? }`）
  - `error`：频道级错误

## 自动心跳与可靠性

`RealtimeClient` 接收全局 `presence` 配置，`joinRoom` 时可进一步覆盖：

```ts
const { channel } = await client.joinRoom(
  { roomId: "fast-room", userId: "user-1" },
  { heartbeatIntervalMs: 3_000, maxMissedHeartbeats: 1 }
);
```

- 心跳定时器在 `leave/stop` 之后自动清理。
- `maxMissedHeartbeats` 控制允许缺失的 ack 次数，超过后会触发 `error` 并自动退出。
- SDK 会缓存 `self.epoch`，并在每次心跳带上最新值，避免旧连接覆盖。

## 自定义事件与 Socket.IO 直连

```ts
// 通过 PresenceChannel 转发
channel.on("chat:message", (payload) => appendMessage(payload));
channel.emit("chat:message", { text: "Hello" });

// 访问底层 socket
const socket = client.getSocket();
socket?.emit("notification:read", { notificationId: "n-1" }, (ack) => {
  console.log("Server ack:", ack);
});
```

## Channel Metadata 客户端

建立连接后可通过 `client.metadata` 调用服务端的频道元数据接口：

```ts
await client.connect();

const metadata = await client.metadata.setChannelMetadata({
  channelType: "room",
  channelName: "room-42",
  actorUserId: "user-123",
  data: [
    { key: "topic", value: "Weekly Sync" },
    { key: "agenda", value: "OKR Review" },
  ],
  options: { addTimestamp: true, addUserId: true },
});

client.metadata.onChannelEvent((event) => {
  console.log(event.operation, event.items);
});
```

可用方法：`setChannelMetadata`、`updateChannelMetadata`、`removeChannelMetadata`、`getChannelMetadata`。服务端会在每次写操作后通过 `metadata:event` 发送增量更新，SDK 会自动监听并触发 `metadataEvent`。

## 多房间与复杂场景

- **多个房间**：重复调用 `joinRoom` 或 `createPresenceChannel + channel.join`，每个频道拥有独立的心跳与事件队列。
- **认证刷新**：`authProvider` 支持异步函数，内部可刷新 Token；返回对象会被序列化为 Socket.IO query。
- **自定义日志**：传入 `logger`（实现 `debug/info/warn/error`）即可接入监控系统。

```ts
const client = new RealtimeClient({
  baseUrl: "...",
  logger: createLogger({ level: "debug", tag: "rtm" }),
});
```

## 浏览器 Demo

1. `npm run dev`（启动服务器）
2. `npm run build:sdk`
3. `npm run sdk:demo` → 打开 `http://localhost:4173`

Demo 支持加入房间、查看心跳日志、发送自定义事件与调试 metadata，适合验证网络或鉴权配置。

## 测试与类型

- `npm run test:sdk`：运行 Vitest 套件（位于 `realtime-message-sdk/src/**.test.ts`）。
- SDK 完整导出 TypeScript 类型，可直接导入：

```ts
import type {
  RealtimeClientConfig,
  PresenceChannel,
  PresenceChannelOptions,
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceHeartbeatResponse,
  PresenceEventEnvelope,
  ConnectionStateSnapshot,
  ChannelMetadataResponse,
} from "@YOUR_SCOPE/realtime-mesage-sdk";
```

## 常见问题

- **连接成功但无法收到事件**：确认浏览器可直连服务器（CORS）且 Heartbeat 未被代理阻断；必要时将 `transports` 限定为 `websocket`（SDK 默认设置）。
- **重复加入同一房间**：请在组件卸载时调用 `channel.leave()`，否则 Redis 会保留旧连接导致 `epoch` 冲突。
- **Metadata 写入报冲突**：携带最新 `majorRevision` 与条目 `revision`，或使用 `options.lockName` 加分布式锁。
- **ACK 超时**：调高 `heartbeatAckTimeoutMs` 或检查服务器端 `presence:heartbeat` 处理是否被长任务阻塞。

