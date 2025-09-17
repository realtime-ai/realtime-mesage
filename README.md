# Realtime Message Service

A production-ready realtime messaging stack built on Socket.IO and Redis. The service provides authoritative presence orchestration, fenced heartbeats, and an event bridge that keeps multiple Socket.IO nodes in sync. A TypeScript web SDK and load-testing harness round out the toolkit so clients can integrate quickly and validate behaviour end-to-end.

## Features

- Redis-backed presence storage with room/user indices, connection hashes, and TTL-based expiry
- Fencing via monotonically increasing epochs to guard against stale heartbeats or duplicate sockets
- Pluggable event bridge (`PresenceService#createSocketBridge`) for forwarding Redis fan-out to any Socket.IO server
- First-class custom event helpers so applications can emit app-specific messages with optional acknowledgements
- Modular web SDK (`rtm-sdk/`) providing `RealtimeMessageClient`, automatic heartbeats, custom event helpers, and a demo playground
- Benchmark harness (`benchmark/presence-load-test.mjs`) to simulate large room fleets and stress-test deployments

## Repository Layout

```
├── src/                  # Node.js Socket.IO + Redis service
├── rtm-sdk/              # Frontend SDK sources, demo page, and build config
├── benchmark/            # Load-test script for presence flows
├── package.json          # Workspace scripts (build, test, sdk demo, benchmark)
└── README.md             # This guide
```

## Getting Started

### Prerequisites

- Node.js 18+
- Redis 6+ (single instance or cluster)

### Installation

```bash
npm install
```

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the Socket.IO server |
| `REDIS_URL` | `redis://localhost:6379` | Connection string for Redis |
| `PRESENCE_TTL_MS` | `30000` | TTL for `prs:conn:<connId>` hashes and heartbeat window |
| `PRESENCE_REAPER_INTERVAL_MS` | `3000` | How often the reaper scans for zombie connections |
| `PRESENCE_REAPER_LOOKBACK_MS` | `2 * PRESENCE_TTL_MS` | Age threshold before a connection is considered stale |

### Run the Service

Development mode (ts-node):

```bash
npm run dev
```

Production build & run:

```bash
npm run build
npm start
```

### Testing

```bash
npm test
```

## Embedding the Service

The `PresenceService` can be embedded inside an existing Node.js application without the bundled Socket.IO HTTP server:

```ts
import { PresenceService } from "realtime-mesage"; // or from local sources
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);
const presence = new PresenceService(redis, {
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
});

// Forward Redis pub/sub events into your own Socket.IO instance
presence
  .createSocketBridge(io)
  .catch((error) => console.error("Failed to start bridge", error));

// Clean up on shutdown
await presence.stop();
```

`PresenceService` also exposes helpers to subscribe to Redis events directly, manage epochs, and tear down subscribers cleanly.

## Socket.IO Protocol

| Event | Payload | Description |
| --- | --- | --- |
| `presence:join` | `{ roomId, userId, state? }` | Registers the connection in Redis and returns a snapshot (ack includes `{ self: { connId, epoch } }`) |
| `presence:heartbeat` | `{ patchState?, epoch? }` | Refreshes TTL/last_seen and optionally patches connection state while carrying the latest epoch |
| `presence:leave` | `void` | Removes the connection and cleans up Redis indices |
| `presence:event` | `{ type, roomId, userId, connId, state?, ts, epoch? }` | Broadcast emitted to all sockets in the room when presence changes |
| _Custom events_ | Any | Applications may emit custom events (e.g. `chat:message`) via the SDK or raw Socket.IO; acknowledgements are optional |

Clients should keep the latest `epoch` returned by `presence:join` and send it with each heartbeat or patch. The server ignores stale writes where the epoch regresses.

## Web SDK & Demo

The `rtm-sdk/` package exposes a browser-friendly `RealtimeMessageClient` with:

- Automatic heartbeat scheduling and fencing-aware acknowledgements
- `emit`/`on` helpers that mirror Socket.IO's API for custom application events
- Type-safe presence responses and event payloads
- A demo playground for manual testing

Build the SDK and launch the demo:

```bash
npm run build:sdk
npm run sdk:demo
```

Visit <http://localhost:4173> to join a room, send presence heartbeats, and experiment with custom events.

## Load Testing

Simulate 100 rooms × 2 users (or any custom scenario) with the benchmark script:

```bash
npm run build:sdk   # optional, if you want fresh dist assets
node benchmark/presence-load-test.mjs
```

Environment variables such as `TARGET_URL`, `ROOM_COUNT`, and `HEARTBEATS_PER_SEC` control the workload. The script records latency percentiles, error counts, and presence events to help validate scale assumptions.

## License

[MIT](./LICENSE)
