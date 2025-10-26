# 🔌 Realtime Message Infrastructure

> A production-ready, modular realtime messaging framework built on Socket.IO and Redis

Build scalable realtime applications with presence orchestration, custom messaging, and pluggable architecture. No vendor lock-in, no over-abstraction—just Socket.IO, Redis, and TypeScript.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)

---

## ✨ Features

### Core Capabilities
- **🔌 Pluggable Module System** - Extend with custom features (chat, notifications, analytics) without touching core code
- **👥 Built-in Presence** - Production-ready presence orchestration with epoch-based fencing and TTL expiry
- **🚀 Zero Abstraction** - Direct access to Socket.IO and Redis APIs—no vendor lock-in
- **⚖️ Horizontal Scaling** - Multi-node support via Redis adapter keeps all servers in sync
- **📦 TypeScript SDK** - Browser client with automatic heartbeats, reconnection, and type safety
- **🔧 Battle-tested** - Includes load testing harness and comprehensive test suite

### What Makes This Different?
- **Infrastructure First** - Core provides routing and state management; modules add domain logic
- **Presence as a Module** - Presence is built-in but optional—swap or remove it as needed
- **No Over-engineering** - Use Socket.IO and Redis directly, exactly as you would without a framework

---

## 📖 Table of Contents
- [Quick Start](#-quick-start)
- [Architecture Overview](#-architecture-overview)
- [Use Cases](#-use-cases)
- [Server Setup](#-server-setup)
- [Creating Custom Modules](#-creating-custom-modules)
- [Client SDK](#-client-sdk)
- [Protocol Reference](#-protocol-reference)
- [Load Testing](#-load-testing)
- [Documentation](#-documentation)

---

## 🚀 Quick Start

### Server (60 seconds to production)

```bash
# Install dependencies
npm install

# Start Redis (required)
docker run -p 6379:6379 redis:7-alpine

# Run server
npm run dev
```

**Basic server setup:**
```typescript
import { RealtimeServer, createPresenceModule } from "realtime-mesage";
import { createServer } from "http";
import { Server } from "socket.io";
import { Redis } from "ioredis";

// Initialize dependencies
const httpServer = createServer();
const io = new Server(httpServer);
const redis = new Redis("redis://localhost:6379");

// Create server and register modules
const server = new RealtimeServer({ io, redis });
server.use(createPresenceModule({
  ttlMs: 30_000,              // Connection expires after 30s
  reaperIntervalMs: 3_000,    // Clean up zombies every 3s
}));

await server.start();
httpServer.listen(3000);
```

### Client (Browser SDK)

```typescript
import { RealtimeClient } from "rtm-sdk";

// Connect and join a room with presence
const client = new RealtimeClient({
  baseUrl: "http://localhost:3000"
});

await client.connect();

const { channel } = await client.joinRoom({
  roomId: "lobby",
  userId: "user-123",
  state: { status: "online", avatar: "https://..." }
});

// Listen for presence events
channel.on("presenceEvent", (event) => {
  console.log(`${event.userId} ${event.type}`, event.state);
});

// Update your state
await channel.updateState({ status: "away" });
```

---

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Applications                      │
│  (Browser SDK • Mobile • Desktop • Server-to-Server)        │
└────────────────────┬────────────────────────────────────────┘
                     │ Socket.IO
┌────────────────────▼────────────────────────────────────────┐
│                   RealtimeServer (Core)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Module System (Pluggable Architecture)             │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │  • Presence Module (Built-in)                       │   │
│  │  • Custom Chat Module (Example)                     │   │
│  │  • Your Custom Modules...                           │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────┬───────────────────────┬────────────────┘
                     │                       │
                     ▼                       ▼
           ┌─────────────────┐    ┌──────────────────┐
           │   Socket.IO     │    │      Redis       │
           │   (Multi-node)  │◄───┤  (Pub/Sub + KV)  │
           └─────────────────┘    └──────────────────┘
```

### Repository Structure

```
realtime-mesage/
├── src/
│   ├── core/              # Framework core (RealtimeServer, module system)
│   ├── modules/presence/  # Built-in presence module with epoch fencing
│   ├── server.ts          # Entry point (59 lines!)
│   └── config.ts          # Environment configuration
├── rtm-sdk/               # TypeScript browser SDK
│   ├── src/
│   │   ├── core/          # RealtimeClient, module context
│   │   └── modules/       # PresenceChannel implementation
│   └── demo/              # Interactive browser demo
├── examples/              # Custom module examples (chat, etc.)
├── benchmark/             # Load testing harness
└── docs/                  # Additional documentation
```

---

## 💡 Use Cases

This infrastructure is ideal for building:

- **Collaboration Tools** - Google Docs-style presence, cursors, and real-time editing
- **Live Chat Applications** - Group messaging with typing indicators and read receipts
- **Multiplayer Games** - Lobby systems, matchmaking, and game state synchronization
- **Live Dashboards** - Real-time analytics with user activity tracking
- **IoT Monitoring** - Device status tracking and command orchestration
- **Social Features** - "Who's online" status, live notifications, activity feeds

---

## 🛠️ Server Setup

### Prerequisites

- **Node.js 18+**
- **Redis 6+** (single instance or cluster)

### Installation

```bash
npm install
```

### Development Commands

```bash
npm run dev               # Start server in development mode (ts-node)
npm run build             # Compile TypeScript to dist/
npm start                 # Run compiled server
npm test                  # Run test suite
npm run build:sdk         # Build browser SDK
npm run sdk:demo          # Launch SDK demo at http://localhost:4173
npm run benchmark:presence # Run load test
```

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for Socket.IO server |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `PRESENCE_TTL_MS` | `30000` | Connection TTL and heartbeat window |
| `PRESENCE_REAPER_INTERVAL_MS` | `3000` | Reaper scan frequency |
| `PRESENCE_REAPER_LOOKBACK_MS` | `60000` | Stale connection age threshold |

---

## 🔌 Creating Custom Modules

Extend the server with custom features without touching core code. Modules have direct access to Socket.IO and Redis.

### Module Interface

```typescript
interface RealtimeModule {
  name: string;
  register(context: ModuleContext): void | Promise<void>;
  onConnection?(socket: Socket, context: ModuleContext): void;
  onShutdown?(): void | Promise<void>;
}

interface ModuleContext {
  io: Server;      // Socket.IO instance
  redis: Redis;    // Redis client
  logger: Logger;  // Logger instance
}
```

### Example: Custom Chat Module

```typescript
import { RealtimeModule, ModuleContext } from "realtime-mesage";
import { Socket } from "socket.io";
import { v4 as uuid } from "uuid";

export function createChatModule(options: { maxHistory?: number } = {}) {
  const maxHistory = options.maxHistory ?? 100;

  const module: RealtimeModule = {
    name: "chat",

    register(context: ModuleContext) {
      context.io.on("connection", (socket: Socket) => {
        // Send message
        socket.on("chat:send", async (payload, ack) => {
          try {
            const { roomId, message } = payload;
            const msgId = uuid();
            const msg = {
              msgId,
              roomId,
              userId: socket.data.userId,
              message,
              ts: Date.now(),
            };

            // Store in Redis
            const key = `chat:${roomId}:messages`;
            await context.redis.zadd(key, msg.ts, JSON.stringify(msg));
            await context.redis.zremrangebyrank(key, 0, -(maxHistory + 1));

            // Broadcast to room
            context.io.to(roomId).emit("chat:message", msg);

            ack?.({ ok: true, msgId });
          } catch (error) {
            context.logger.error("chat:send error", { error });
            ack?.({ ok: false, error: "Failed to send message" });
          }
        });

        // Get history
        socket.on("chat:history", async (payload, ack) => {
          try {
            const { roomId, limit = 50 } = payload;
            const key = `chat:${roomId}:messages`;
            const messages = await context.redis.zrange(key, -limit, -1);
            ack?.({
              ok: true,
              messages: messages.map((m) => JSON.parse(m))
            });
          } catch (error) {
            context.logger.error("chat:history error", { error });
            ack?.({ ok: false, error: "Failed to load history" });
          }
        });
      });
    },

    async onShutdown() {
      // Cleanup resources if needed
    },
  };

  return module;
}
```

### Register Your Module

```typescript
import { RealtimeServer } from "realtime-mesage";
import { createChatModule } from "./chat-module";

const server = new RealtimeServer({ io, redis });

// Register built-in and custom modules
server.use(createPresenceModule());
server.use(createChatModule({ maxHistory: 100 }));

await server.start();
```

**See Also:**
- Complete chat module example: [`examples/custom-chat-module/`](./examples/custom-chat-module/)
- Detailed module guide: [CLAUDE.md - Creating Custom Modules](./CLAUDE.md#creating-custom-modules)

---

## 📱 Client SDK

The `rtm-sdk/` package provides a TypeScript browser client with automatic heartbeats, reconnection, and type safety.

### Installation & Build

```bash
npm run build:sdk   # Compiles SDK to rtm-sdk/dist/
```

### Basic Usage

```typescript
import { RealtimeClient } from "rtm-sdk";

const client = new RealtimeClient({
  baseUrl: "http://localhost:3000",
  authProvider: async () => ({
    Authorization: `Bearer ${await getAuthToken()}`
  }),
});

await client.connect();

// Join room with presence
const { channel, response } = await client.joinRoom({
  roomId: "room-123",
  userId: "user-456",
  state: { status: "online" }
});

// Listen for presence events
channel.on("presenceEvent", (event) => {
  console.log(`${event.type}: ${event.userId}`, event.state);
});

// Update state (triggers heartbeat)
await channel.updateState({ typing: true });

// Custom events
channel.on("chat:message", (msg) => console.log(msg));
channel.emit("chat:message", { text: "Hello!" });

// Cleanup
await channel.leave();
await client.disconnect();
```

### Interactive Demo

```bash
npm run sdk:demo    # Opens http://localhost:4173
```

**Full SDK documentation:** [`rtm-sdk/README.md`](./rtm-sdk/README.md)

---

## 📋 Protocol Reference

### Presence Events

| Event | Direction | Payload | Description |
| --- | --- | --- | --- |
| `presence:join` | Client → Server | `{ roomId, userId, state? }` | Join room and get snapshot |
| `presence:heartbeat` | Client → Server | `{ patchState?, epoch }` | Refresh TTL and update state |
| `presence:leave` | Client → Server | `void` | Leave room |
| `presence:event` | Server → Client | `{ type, roomId, userId, connId, state?, ts, epoch }` | Broadcast presence change |

**Epoch Fencing:** Clients must send the latest `epoch` (returned by `presence:join`) with each heartbeat. Server rejects stale writes where epoch regresses, preventing race conditions.

### Custom Events

Applications can emit custom events via the SDK or raw Socket.IO:

```typescript
// With SDK
channel.emit("chat:message", { text: "Hello" }, (response) => {
  console.log("Acknowledged:", response);
});

// With raw Socket.IO
socket.emit("analytics:track", { event: "page_view" });
```

---

## 🔥 Load Testing

Validate scale assumptions with the built-in benchmark harness:

```bash
npm run benchmark:presence
```

**Custom scenarios:**
```bash
# 50 rooms × 10 users, 30s duration
ROOM_COUNT=50 USERS_PER_ROOM=10 TEST_DURATION_MS=30000 \
  node benchmark/presence-load-test.mjs
```

**Metrics tracked:**
- Latency percentiles (p50, p95, p99)
- Error counts and types
- Presence event delivery
- Connection stability

**Environment variables:**
- `TARGET_URL` - Server URL (default: `http://localhost:3000`)
- `ROOM_COUNT` - Number of rooms (default: 100)
- `USERS_PER_ROOM` - Users per room (default: 2)
- `TEST_DURATION_MS` - Test duration (default: 60000)
- `HEARTBEATS_PER_SEC` - Heartbeat rate (default: 0.1)

---

## 📚 Documentation

- **[CLAUDE.md](./CLAUDE.md)** - Comprehensive development guide for Claude Code
- **[rtm-sdk/README.md](./rtm-sdk/README.md)** - Complete SDK documentation with examples
- **[examples/custom-chat-module/](./examples/custom-chat-module/)** - Custom module tutorial
- **[docs/sdk-usage.md](./docs/sdk-usage.md)** - Advanced SDK patterns
- **[docs/publishing.md](./docs/publishing.md)** - Package publishing guide

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Development Workflow

```bash
# Run tests
npm test

# Run E2E tests (requires Redis)
npm run test:e2e

# Run benchmarks
npm run benchmark:presence

# Build everything
npm run build && npm run build:sdk
```

---

## 📄 License

[MIT](./LICENSE)

---

## 🎯 Project Goals

1. **No vendor lock-in** - Use Socket.IO and Redis directly
2. **Modularity** - Add features without modifying core
3. **Production-ready** - Includes presence with epoch fencing, TTL expiry, and zombie cleanup
4. **Developer experience** - TypeScript, comprehensive docs, and working examples
5. **Battle-tested** - Load testing harness included

Built with ❤️ for real-time applications
