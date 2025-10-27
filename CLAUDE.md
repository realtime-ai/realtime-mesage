# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A modular realtime message infrastructure built on Socket.IO and Redis. The project provides core messaging capabilities with built-in presence orchestration as a pluggable module.

**Core Philosophy:**
- Provide realtime infrastructure (connections, routing, state management)
- Presence is a built-in module (not the primary focus)
- Extensible through pluggable modules
- Direct access to Socket.IO and Redis (no over-abstraction)

**Repository Structure (Monorepo):**
- **[packages/server/src/core/](packages/server/src/core/)** - Core framework (RealtimeServer, module system)
- **[packages/server/src/modules/presence/](packages/server/src/modules/presence/)** - Built-in presence module
- **[packages/server/examples/](packages/server/examples/)** - Custom module examples
- **[packages/sdk/](packages/sdk/)** - Browser SDK (@realtime-mesage/sdk)
- **[packages/server/benchmark/](packages/server/benchmark/)** - Load-testing harness

## Common Commands

### Development & Build
```bash
pnpm dev             # Run server in development mode (ts-node)
pnpm build           # Compile all packages (server + SDK)
pnpm build:server    # Compile server TypeScript to packages/server/dist/
pnpm build:sdk       # Compile SDK TypeScript to packages/sdk/dist/
pnpm start           # Run compiled server from dist/
```

### Testing & Benchmarking
```bash
pnpm test                       # Run all test suites (Vitest)
pnpm test:server                # Run server tests only
pnpm test:sdk                   # Run SDK tests only
pnpm test:e2e                   # Run E2E integration tests (requires Redis)
pnpm benchmark:presence         # Launch load test (100 rooms × 2 users)
pnpm sdk:demo                   # Serve SDK demo at http://localhost:4173
```

## Architecture

### Core Framework

**RealtimeServer** ([packages/server/src/core/realtime-server.ts](packages/server/src/core/realtime-server.ts:1)) manages module registration and lifecycle:

```typescript
const server = new RealtimeServer({ io, redis });
server.use(createPresenceModule(options));  // Register modules
await server.start();
```

**Module Interface** ([packages/server/src/core/types.ts](packages/server/src/core/types.ts:1)):
```typescript
interface RealtimeModule {
  name: string;
  register(context: ModuleContext): void | Promise<void>;
  onConnection?(socket: Socket, context: ModuleContext): void;
  onShutdown?(): void | Promise<void>;
}

interface ModuleContext {
  io: Server;      // Direct Socket.IO access
  redis: Redis;    // Direct Redis access
  logger: Logger;
}
```

### Presence Module

**Location:** [packages/server/src/modules/presence/](packages/server/src/modules/presence/)

Provides authoritative presence orchestration with:
- **Epoch-based fencing**: Monotonically increasing `epoch` prevents race conditions from stale heartbeats
- **TTL-based expiry**: Connections expire if heartbeats stop
- **Reaper**: Background task removes zombie connections
- **Pub/sub bridge**: Broadcasts presence events via Redis to all Socket.IO nodes

**Files:**
- [service.ts](packages/server/src/modules/presence/service.ts:1) - Core business logic (formerly PresenceService)
- [handlers.ts](packages/server/src/modules/presence/handlers.ts:1) - Socket.IO event handlers (join/heartbeat/leave)
- [index.ts](packages/server/src/modules/presence/index.ts:1) - Module factory (`createPresenceModule`)
- [keys.ts](packages/server/src/modules/presence/keys.ts:1) - Redis key patterns
- [types.ts](packages/server/src/modules/presence/types.ts:1) - Type definitions

**Redis Data Model:**
- `prs:conn:<connId>` - Connection hash (userId, roomId, state, epoch, last_seen_ms) with TTL
- `prs:{room:<roomId>}:conns` - Set of active connections per room
- `prs:{room:<roomId>}:members` - Set of unique userIds per room
- `prs:{room:<roomId>}:last_seen` - Sorted set for reaper scans
- `prs:{room:<roomId>}:conn_meta` - Fast userId/epoch lookups
- `prs:user:<userId>:conns` - User's connections across rooms
- `prs:{room:<roomId>}:events` - Pub/sub channel for presence events

**Usage:**
```typescript
server.use(createPresenceModule({
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
}));
```

### Server Entry Point

**[packages/server/src/server.ts](packages/server/src/server.ts:1)** (59 lines):
1. Initialize Socket.IO + Redis
2. Create RealtimeServer and register modules
3. Start server
4. Handle graceful shutdown

**Key Difference from Pre-Refactor:**
- **Before:** 188 lines with all presence logic inline
- **After:** 59 lines, all presence logic in module

### SDK Client

**RealtimeClient** ([packages/sdk/src/core/realtime-client.ts](packages/sdk/src/core/realtime-client.ts)) provides a high-level browser API:

- **PresenceChannel** ([packages/sdk/src/modules/presence/presence-channel.ts](packages/sdk/src/modules/presence/presence-channel.ts)) encapsulates a single room's lifecycle:
  - Auto-schedules heartbeats every `heartbeatIntervalMs` (default 10s).
  - Tracks missed heartbeats and fires errors when threshold exceeded.
  - Merges client hooks with internal EventEmitter for `connect`, `disconnect`, `reconnect`, `presenceEvent`, etc.
  - Supports custom app events via overloaded `emit()` with optional ack/timeout.

### Creating Custom Modules

See [packages/server/examples/custom-chat-module/](packages/server/examples/custom-chat-module/) for a complete example.

**Basic Pattern:**
```typescript
export function createMyModule(options): RealtimeModule {
  return {
    name: "my-module",

    register(context) {
      context.io.on("connection", (socket) => {
        socket.on("my:event", async (payload, ack) => {
          await context.redis.set("key", "value");
          context.io.to(payload.roomId).emit("my:broadcast", data);
          ack?.({ ok: true });
        });
      });
    },

    async onShutdown() {
      // Cleanup resources
    },
  };
}
```

**Register it:**
```typescript
server.use(createMyModule(options));
```

## Environment Variables

See [packages/server/src/config.ts](packages/server/src/config.ts) for defaults. Key variables:

- `PORT`: HTTP server port (default: 3000)
- `REDIS_URL`: Redis connection string (default: redis://localhost:6379)
- `PRESENCE_TTL_MS`: TTL for connection hashes and heartbeat window (default: 30000)
- `PRESENCE_REAPER_INTERVAL_MS`: Reaper scan frequency (default: 3000)
- `PRESENCE_REAPER_LOOKBACK_MS`: Age threshold for stale connection cleanup (default: 2 × TTL)

## Testing

Tests are located in [packages/server/src/modules/presence/service.test.ts](packages/server/src/modules/presence/service.test.ts:1) and use `ioredis-mock`.

**Run specific test:**
```bash
npx vitest run -t "test name pattern"
```

## Key Constraints

### Presence Module
- **Epoch fencing:** Always send latest epoch in heartbeats; server rejects stale epochs
- **TTL refresh:** Heartbeat within `PRESENCE_TTL_MS` or connection expires
- **Single room per socket:** Each socket can only join one presence room

### Module System
- **No Transport Abstraction:** Modules use Socket.IO directly (`context.io`)
- **No Storage Abstraction:** Modules use Redis directly (`context.redis`)
- **Register Before Start:** Modules must be registered before calling `server.start()`

## Migration Notes

### If Upgrading from Pre-Refactor Version

**Import Changes:**
```typescript
// Before
import { PresenceService } from "realtime-mesage/presence/presence-service";

// After
import { PresenceService, createPresenceModule } from "realtime-mesage";
```

**Server Setup:**
```typescript
// Before
const presenceService = new PresenceService(redis, options);
await presenceService.createSocketBridge(io);
presenceService.startReaper();
io.on("connection", (socket) => { /* inline handlers */ });

// After
const server = new RealtimeServer({ io, redis });
server.use(createPresenceModule(options));
await server.start();  // Handles bridge + reaper + handlers
```

## Development Guidelines

1. **Module Independence:** Each module should be self-contained and not depend on other modules
2. **Direct API Usage:** Use `context.io` and `context.redis` directly; avoid creating abstraction layers
3. **Error Handling:** Always wrap event handlers in try/catch and send proper acknowledgements
4. **Cleanup:** Implement `onShutdown()` to clean up timers, subscribers, etc.
5. **Testing:** Test modules by mocking `ModuleContext` (see presence tests for examples)
