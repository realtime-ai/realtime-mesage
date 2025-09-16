# Realtime Presence Service

A production-ready Socket.IO + Redis presence implementation. The server allows multiple Socket.IO instances to share presence information (room membership, connection metadata, state updates) across processes by storing authoritative state in Redis and distributing events through Redis Pub/Sub.

## Features

- Redis-backed presence storage with room/user sets, connection hashes and TTL based expiry
- Cross-node Socket.IO broadcasting through `@socket.io/redis-adapter`
- Join/Heartbeat/Leave protocol with optimistic state patching and Redis Pub/Sub fanout
- Background reaper to cull zombie connections when TTLs expire
- Configurable via environment variables with safe defaults

## Getting Started

### Prerequisites

- Node.js 18+
- Redis 6+ (single instance or cluster)

### Installation

```bash
npm install
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the Socket.IO server |
| `REDIS_URL` | `redis://localhost:6379` | Connection string for Redis |
| `PRESENCE_TTL_MS` | `30000` | TTL for `prs:conn:<connId>` hashes and heartbeat window |
| `PRESENCE_REAPER_INTERVAL_MS` | `3000` | How often the reaper scans for zombies |
| `PRESENCE_REAPER_LOOKBACK_MS` | `2 * PRESENCE_TTL_MS` | Age threshold for considering a connection stale |

### Running in development

```bash
npm run dev
```

### Production build & run

```bash
npm run build
npm start
```

### Testing

```bash
npm test
```

## Library usage

The `PresenceService` can be embedded in an existing application without the bundled Socket.IO server:

```ts
import { PresenceService } from "realtime-mesage"; // or from the local TypeScript sources
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);
const presence = new PresenceService(redis, {
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
});

// Forward Pub/Sub events to your own transport
await presence.subscribe((event) => {
  console.log("presence event", event);
});

// Clean up on shutdown
await presence.stop();
```

The module also re-exports key builders and type definitions from `src/index.ts` for reuse in external integrations and tests.

## Socket.IO Events

| Event | Payload | Description |
| --- | --- | --- |
| `presence:join` | `{ roomId, userId, state? }` | Registers the connection in Redis and returns a snapshot of the room presence |
| `presence:heartbeat` | `{ patchState? }` | Refreshes TTL/last_seen and optionally patches presence state |
| `presence:leave` | `void` | Gracefully leaves the room |
| `presence:event` | `{ type, roomId, userId, connId, state?, ts }` | Broadcast emitted to all sockets in the room when presence changes |

Client libraries should listen for `presence:event` to drive UI updates and periodically call `presence:heartbeat` (10–15s) to keep the connection alive.

## Project Structure

```
src/
  config.ts                 # Environment handling
  server.ts                 # Socket.IO HTTP server entrypoint
  presence/
    presence-service.ts     # Redis operations + reaper + event bridge
    redis-keys.ts           # Helper key builders
    types.ts                # Shared presence contracts
```

## License

[MIT](./LICENSE)
