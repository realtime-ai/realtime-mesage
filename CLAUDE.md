# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A focused realtime presence service built on Socket.IO and Redis. Instead of a pluggable module framework, the backend exposes a single helper that wires presence join/heartbeat/leave handlers onto an existing Socket.IO server. The browser SDK pairs with this backend to manage heartbeats, reconnection, and custom events.

**Core Philosophy:**
- Provide a production-ready presence primitive (connections, state, fencing) with minimal ceremony
- Keep direct access to Socket.IO and Redis for advanced use cases
- Avoid over-abstraction so applications can extend behaviour alongside the provided handlers

**Repository Structure:**
- **[backend/src/presence/](backend/src/presence/)** - Presence service implementation (Redis logic, socket handlers)
- **[backend/src/presence-server.ts](backend/src/presence-server.ts)** - `initPresence` bootstrap helper
- **[backend/examples/](backend/examples/)** - Sample presence server wiring
- **[realtime-message-sdk/](realtime-message-sdk/)** - Browser SDK (`RealtimeClient`, `PresenceChannel`)
- **[backend/benchmark/](backend/benchmark/)** - Load-testing harness

## Common Commands

### Development & Build
```bash
npm run dev          # Run server in development mode (ts-node)
npm run build        # Compile server TypeScript to dist/
npm run build:sdk    # Compile SDK TypeScript to realtime-message-sdk/dist/
npm start            # Run compiled server from dist/
```

### Testing & Benchmarking
```bash
npm test                        # Run test suite (Vitest)
npm run benchmark:presence      # Launch load test (100 rooms × 2 users)
npm run sdk:demo                # Serve SDK demo at http://localhost:4173
```

## Architecture

### Presence Server

**Bootstrap Helper:** [`initPresence`](backend/src/presence-server.ts) accepts a Socket.IO server and Redis client, wires all handlers, and returns a disposable runtime:

```typescript
const presence = await initPresence({
  io,
  redis,
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
});

// Optional cleanup (tests, graceful shutdown)
await presence.dispose();
```

Internally it:
- Instantiates a `PresenceService`
- Creates a Redis pub/sub bridge to broadcast events across nodes
- Registers socket handlers for join/heartbeat/leave/disconnect
- Starts the background reaper loop

### Presence Implementation

**Location:** [backend/src/presence/](backend/src/presence/)

Provides authoritative presence orchestration with:
- **Epoch-based fencing**: Monotonically increasing `epoch` prevents race conditions from stale heartbeats
- **TTL-based expiry**: Connections expire if heartbeats stop
- **Reaper**: Background task removes zombie connections
- **Pub/sub bridge**: Broadcasts presence events via Redis to all Socket.IO nodes

**Files:**
- [service.ts](backend/src/presence/service.ts) - Redis data model, joins, heartbeats, reaper, bridge
- [handlers.ts](backend/src/presence/handlers.ts) - Socket.IO event handlers
- [keys.ts](backend/src/presence/keys.ts) - Redis key helpers
- [types.ts](backend/src/presence/types.ts) - Shared types for presence events and metadata

**Redis Data Model:**
- `prs:conn:<connId>` - Connection hash (userId, roomId, state, epoch, last_seen_ms) with TTL
- `prs:{room:<roomId>}:conns` - Set of active connections per room
- `prs:{room:<roomId>}:members` - Set of unique userIds per room
- `prs:{room:<roomId>}:last_seen` - Sorted set for reaper scans
- `prs:{room:<roomId>}:conn_meta` - Fast userId/epoch lookups
- `prs:user:<userId>:conns` - User's connections across rooms
- `prs:{room:<roomId>}:events` - Pub/sub channel for presence events

### Server Entry Point

**[src/server.ts](src/server.ts)** demonstrates wiring:
1. Initialize Socket.IO + Redis (+ adapter)
2. Call `initPresence(...)`
3. Start HTTP server
4. On shutdown, call `presence.dispose()` and close Redis/socket resources

### SDK Client

**RealtimeClient** ([realtime-message-sdk/src/core/realtime-client.ts](realtime-message-sdk/src/core/realtime-client.ts)) is the primary entry point:

- Wraps Socket.IO client creation (`socket.io-client`)
- Handles auth query resolution, reconnection, and channel teardown on shutdown
- Exposes convenience helpers:
  - `createPresenceChannel()` / `joinRoom()` for room lifecycle
  - `PresenceChannel` ([realtime-message-sdk/src/modules/presence/presence-channel.ts](realtime-message-sdk/src/modules/presence/presence-channel.ts)) with automatic heartbeats, `emit` helpers, and presence events

## Environment Variables

See [src/config.ts](src/config.ts) for defaults. Key variables:

- `PORT`: HTTP server port (default: 3000)
- `REDIS_URL`: Redis connection string (default: redis://localhost:6379)
- `PRESENCE_TTL_MS`: TTL for connection hashes and heartbeat window (default: 30000)
- `PRESENCE_REAPER_INTERVAL_MS`: Reaper scan frequency (default: 3000)
- `PRESENCE_REAPER_LOOKBACK_MS`: Age threshold for stale connection cleanup (default: 2 × TTL)

## Testing

Tests are located in [src/presence/service.test.ts](backend/src/presence/service.test.ts) and use `ioredis-mock`.

**Run specific test:**
```bash
npx vitest run -t "test name pattern"
```

## Key Constraints

### Presence Runtime
- **Epoch fencing:** Always send latest epoch in heartbeats; server rejects stale epochs.
- **TTL refresh:** Heartbeats must occur within `PRESENCE_TTL_MS` or the connection expires.
- **Single room per socket:** Each socket can only participate in one presence room at a time (tracked on `socket.data`).
- **Graceful shutdown:** Call `dispose()` before terminating the process to stop the reaper and unsubscribe Redis listeners (tests / graceful restarts).

## Migration Notes

### If Upgrading from the Module-Based Version

- Replace `RealtimeServer` + `createPresenceModule` usage with a single call to `initPresence`.
- Drop any custom modules registered through `server.use(...)`; instead, attach additional socket listeners directly to the `io` instance alongside `initPresence`.
- If you previously relied on `server.shutdown()`, switch to storing the runtime returned by `initPresence` and call `runtime.dispose()` during teardown.

## Development Guidelines

1. **Keep Epoch Monotonic:** Whenever you surface new endpoints that touch presence state, ensure incoming epochs never decrease.
2. **Reuse `socket.data`:** Stick to `socket.data.presenceRoomId` / `presenceUserId` so auxiliary handlers can rely on them.
3. **Try/Catch Socket Handlers:** Presence handlers wrap Redis calls in try/catch; follow the same pattern for custom events to avoid killing the connection.
4. **Clean Shutdowns:** Always dispose the runtime in tests or custom servers to release Redis subscribers and timers.
5. **Testing:** Use the helpers in `backend/src/test-utils` (mock Redis, mock logger) when adding new presence scenarios.
