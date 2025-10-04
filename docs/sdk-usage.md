# RTM SDK 使用指南

实时消息（RTM）SDK 是一个轻量级的 JavaScript 客户端库，基于 Socket.IO 构建，内置 Presence（在线状态）支持和模块化架构。

## 安装

```bash
npm run build:sdk
```

构建产物位于 `rtm-sdk/dist`，可以作为 npm 包发布或在项目中直接引用。

## 快速开始

### 基础 Presence 用法

```ts
import { RealtimeClient } from "rtm-sdk";

// 创建并连接客户端
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: () => ({ token: localStorage.getItem("authToken") ?? "" }),
});

await client.connect();

// 加入房间（自动启用 Presence）
const { channel, response } = await client.joinRoom({
  roomId: "room-42",
  userId: "user-123",
  state: { mic: true, camera: false },
});

if (!response.ok) {
  console.error("加入失败:", response.error);
  return;
}

// 监听 Presence 事件
channel.on("presenceEvent", (event) => {
  console.log(`${event.type}: ${event.userId}`, event.state);
});

channel.on("snapshot", (snapshot) => {
  console.log("当前房间成员:", snapshot);
});

// 更新状态
await channel.updateState({ typing: true });

// 离开房间
await channel.leave();
```

## 核心 API

### RealtimeClient

主客户端管理 Socket.IO 连接生命周期，提供内置的 Presence API。

```ts
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",

  // 可选：认证信息（添加到 Socket.IO 握手）
  authProvider: async () => {
    const token = await fetchAuthToken();
    return { Authorization: `Bearer ${token}` };
  },

  // 可选：Presence 默认配置
  presence: {
    heartbeatIntervalMs: 10000,        // 默认 10秒
    heartbeatAckTimeoutMs: 8000,       // 默认为间隔的 80%
    maxMissedHeartbeats: 2,            // 默认 2次
    presenceEventName: "presence:event",
  },

  // 可选：自定义日志
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },

  // 可选：连接配置
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelayMax: 5000,
});

// 建立连接
await client.connect();

// 检查连接状态
if (client.isConnected()) {
  console.log("已连接!");
}

// 断开连接
await client.disconnect();
```

### Presence API

#### `client.joinRoom(params, options?)`

加入房间并启用 Presence（便捷方法，自动创建 channel 并加入）。

```ts
const { channel, response } = await client.joinRoom(
  {
    roomId: "room-123",
    userId: "user-456",
    state: { status: "online", avatar: "https://..." },
  },
  {
    heartbeatIntervalMs: 5000, // 可选：覆盖默认值
  }
);

if (response.ok) {
  console.log("加入成功", response.self.connId);
} else {
  console.error("加入失败:", response.error);
}
```

#### `client.createPresenceChannel(options?)`

创建自定义配置的 Presence Channel（更灵活的控制）。

```ts
const channel = client.createPresenceChannel({
  heartbeatIntervalMs: 15000,
  maxMissedHeartbeats: 3,
});

const response = await channel.join({
  roomId: "room-123",
  userId: "user-456",
  state: { mic: true },
});
```

## Presence Channel

### 事件监听

```ts
// 连接到房间
channel.on("connected", ({ connId }) => {
  console.log("加入房间，连接ID:", connId);
});

// 房间成员初始快照
channel.on("snapshot", (members) => {
  members.forEach(member => {
    console.log(member.userId, member.state);
  });
});

// 实时 Presence 更新
channel.on("presenceEvent", (event) => {
  switch (event.type) {
    case "join":
      console.log(`${event.userId} 加入`, event.state);
      break;
    case "leave":
      console.log(`${event.userId} 离开`);
      break;
    case "update":
      console.log(`${event.userId} 更新状态`, event.state);
      break;
  }
});

// 心跳确认
channel.on("heartbeatAck", (response) => {
  if (response.ok) {
    console.log("心跳已确认");
  }
});

// 错误处理
channel.on("error", (error) => {
  console.error("Channel 错误:", error);
});
```

### 方法

```ts
// 更新状态（触发心跳）
await channel.updateState({ typing: true, cursor: { x: 100, y: 200 } });

// 手动发送心跳
await channel.sendHeartbeat({ patchState: { online: true } });

// 离开房间（停止心跳）
await channel.leave();

// 停止 channel（离开 + 清理）
await channel.stop();
```

## 自定义消息

### 通过 Presence Channel 发送自定义事件

Presence Channel 支持应用自定义事件：

```ts
// 监听自定义事件
const unsubscribe = channel.on("chat:message", (message) => {
  console.log("收到聊天消息:", message);
});

// 发送事件（无需确认）
channel.emit("chat:message", { text: "Hello world" });

// 发送带回调确认
channel.emit("chat:typing", { userId: "user-123" }, (response) => {
  console.log("服务端确认:", response);
});

// 发送带 Promise 确认
const response = await channel.emit<{ success: boolean }>(
  "chat:reaction",
  { emoji: "👍", messageId: "msg-456" },
  { ack: true, timeoutMs: 5000 }
);

// 清理
unsubscribe();
```

### 直接访问 Socket.IO

对于高级用例，可以直接访问 Socket.IO socket：

```ts
await client.connect();
const socket = client.getSocket();

// 监听自定义事件
socket.on("notification:new", (payload) => {
  console.log("新通知:", payload);
});

// 发送事件并确认
socket.emit("analytics:track", { event: "page_view" }, (response) => {
  console.log("已追踪:", response);
});

// 请求-响应模式
socket.emit("user:profile", { userId: "123" }, (profile) => {
  console.log("用户资料:", profile);
});
```

## 创建自定义模块

可以为特定业务功能创建自定义模块（如聊天、通知、分析等）。

### 示例：聊天模块

```ts
import type { ClientModule, ClientModuleContext } from "rtm-sdk";

export interface ChatMessage {
  msgId: string;
  roomId: string;
  userId: string;
  message: string;
  ts: number;
}

export interface ChatModuleAPI {
  sendMessage(roomId: string, message: string): Promise<{ msgId: string }>;
  onMessage(handler: (msg: ChatMessage) => void): () => void;
  loadHistory(roomId: string, limit?: number): Promise<ChatMessage[]>;
}

export function createChatModule(): ClientModule & { api: ChatModuleAPI } {
  let context: ClientModuleContext | null = null;
  const messageHandlers = new Set<(msg: ChatMessage) => void>();

  const api: ChatModuleAPI = {
    async sendMessage(roomId: string, message: string) {
      if (!context) throw new Error("Chat 模块未初始化");

      return new Promise((resolve, reject) => {
        context.socket.emit(
          "chat:send",
          { roomId, message },
          (response: { ok: boolean; msgId?: string; error?: string }) => {
            if (response.ok && response.msgId) {
              resolve({ msgId: response.msgId });
            } else {
              reject(new Error(response.error || "发送失败"));
            }
          }
        );
      });
    },

    onMessage(handler: (msg: ChatMessage) => void) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    async loadHistory(roomId: string, limit = 50) {
      if (!context) throw new Error("Chat 模块未初始化");

      return new Promise((resolve, reject) => {
        context.socket.emit(
          "chat:history",
          { roomId, limit },
          (response: { ok: boolean; messages?: ChatMessage[]; error?: string }) => {
            if (response.ok && response.messages) {
              resolve(response.messages);
            } else {
              reject(new Error(response.error || "加载失败"));
            }
          }
        );
      });
    },
  };

  return {
    name: "chat",
    api,

    onConnected(ctx: ClientModuleContext) {
      context = ctx;
      ctx.logger.info("Chat 模块已连接");

      ctx.socket.on("chat:message", (msg: ChatMessage) => {
        messageHandlers.forEach(handler => handler(msg));
      });
    },

    onDisconnected() {
      context = null;
    },

    onShutdown() {
      messageHandlers.clear();
    },
  };
}
```

### 使用自定义模块

```ts
import { RealtimeClient } from "rtm-sdk";
import { createChatModule } from "./chat-module";

const client = new RealtimeClient({ baseUrl: "https://rtm.yourdomain.com" });

// 注册自定义聊天模块
const chatModule = createChatModule();
client.use(chatModule);

await client.connect();

// 监听消息
const unsubscribe = chatModule.api.onMessage((msg) => {
  console.log(`${msg.userId}: ${msg.message}`);
});

// 发送消息
const { msgId } = await chatModule.api.sendMessage("room-123", "你好!");

// 加载历史
const history = await chatModule.api.loadHistory("room-123", 100);
```

## 完整示例：Presence + 自定义消息

```ts
import { RealtimeClient } from "rtm-sdk";

// 初始化客户端
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: () => ({ token: getAuthToken() }),
  presence: {
    heartbeatIntervalMs: 5000, // 每 5 秒发送心跳
  },
});

// 连接
await client.connect();

// 加入房间
const { channel } = await client.joinRoom({
  roomId: "collab-room-42",
  userId: "user-123",
  state: { cursor: null, selection: null },
});

// 追踪 Presence
channel.on("presenceEvent", (event) => {
  if (event.type === "join") {
    addUserToUI(event.userId, event.state);
  } else if (event.type === "leave") {
    removeUserFromUI(event.userId);
  } else if (event.type === "update") {
    updateUserInUI(event.userId, event.state);
  }
});

// 用户操作时更新状态
document.addEventListener("mousemove", async (e) => {
  await channel.updateState({ cursor: { x: e.clientX, y: e.clientY } });
});

// 自定义消息：聊天
channel.on("chat:message", ({ userId, text, ts }) => {
  appendMessageToChat(userId, text, ts);
});

channel.emit("chat:message", {
  text: "大家好!",
  ts: Date.now()
});

// 自定义消息：反应
channel.on("reaction:add", ({ userId, emoji, targetId }) => {
  addReactionToElement(targetId, emoji, userId);
});

const ackResponse = await channel.emit(
  "reaction:add",
  { emoji: "👍", targetId: "msg-456" },
  { ack: true, timeoutMs: 3000 }
);

if (ackResponse.ok) {
  console.log("反应添加成功");
}

// 清理
await channel.leave();
await client.disconnect();
```

## TypeScript 支持

SDK 使用 TypeScript 编写，提供完整的类型定义：

```ts
import type {
  // 核心类型
  RealtimeClientConfig,
  ClientModule,
  ClientModuleContext,
  Logger,

  // Presence 类型
  PresenceChannel,
  PresenceChannelOptions,
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceHeartbeatResponse,
  PresenceEventEnvelope,
  ConnectionStateSnapshot,
  PresenceStatePatch,
  PresenceChannelEventMap,
  CustomEmitOptions,
} from "rtm-sdk";
```

## 高级模式

### 多个 Presence Channel

```ts
await client.connect();

// 同时加入多个房间
const { channel: workspaceChannel } = await client.joinRoom({
  roomId: "workspace-1",
  userId: "user-123",
  state: { status: "online" },
});

const { channel: documentChannel } = await client.joinRoom({
  roomId: "document-456",
  userId: "user-123",
  state: { cursor: null, selection: null },
});

// 每个 channel 有独立的生命周期和状态
workspaceChannel.on("presenceEvent", handleWorkspacePresence);
documentChannel.on("presenceEvent", handleDocumentPresence);
```

### 认证令牌刷新

```ts
let authToken = "";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: async () => {
    // 需要时刷新令牌
    if (isTokenExpired(authToken)) {
      authToken = await refreshAuthToken();
    }
    return { Authorization: `Bearer ${authToken}` };
  },
});
```

### 自定义日志集成

```ts
import { createLogger } from "./my-logger";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  logger: createLogger({
    level: "debug",
    prefix: "[RTM]"
  }),
});
```

### 按 Channel 覆盖 Presence 默认值

```ts
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  presence: {
    heartbeatIntervalMs: 10000, // 全局默认
  },
});

await client.connect();

// 使用默认配置
const { channel: channel1 } = await client.joinRoom({
  roomId: "room-1",
  userId: "user-123",
});

// 覆盖特定 channel 配置
const { channel: channel2 } = await client.joinRoom(
  {
    roomId: "room-2",
    userId: "user-123",
  },
  {
    heartbeatIntervalMs: 3000, // 更频繁的心跳
  }
);
```

## 交互式 Demo

启动本地服务器并打开交互式 Demo：

```bash
npm run dev              # 启动服务器
npm run build:sdk        # 构建 SDK
npm run sdk:demo         # 打开 demo (http://localhost:4173)
```

Demo 功能：
- 连接到 RTM 服务器
- 加入带 Presence 的房间
- 发送心跳和状态更新
- 查看实时 Presence 事件
- 测试自定义事件

## 项目结构

```
rtm-sdk/
  src/
    core/
      realtime-client.ts       # 核心客户端（内置 Presence API）
      types.ts                 # 核心接口和类型
      event-emitter.ts         # 事件发射器基类
    modules/
      presence/
        presence-channel.ts    # Presence Channel 实现
        types.ts               # Presence 类型
    index.ts                   # SDK 主导出
  examples/
    chat-client-module/        # 聊天模块示例
  demo/
    index.html                 # 浏览器交互式 Demo
  tsconfig.json                # TypeScript 配置
```

## 下一步

- 将 SDK 构建产物集成到发布流程
- 为业务需求创建自定义模块（聊天、通知、分析等）
- 添加自动化测试（如 Vitest + Socket.IO mock server）
- 探索[服务端模块系统](../CLAUDE.md)构建对应的服务端功能
