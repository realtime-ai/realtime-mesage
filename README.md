# Realtime Message Infrastructure

A streamlined realtime presence stack built on Socket.IO and Redis. The backend exposes a single helper to wire presence into an existing Socket.IO server, and the browser SDK offers batteries-included room management with automatic heartbeats.

## Features

- **Single Call Bootstrap**: `initPresence({ io, redis })` wires join/heartbeat/leave handlers for you
- **Battle-tested Presence**: Epoch fencing, TTL enforcement, and automatic reaping of stale connections
- **Horizontal Scaling**: Redis pub/sub bridge keeps Socket.IO clusters in sync
- **TypeScript SDK**: Lightweight browser client with heartbeats, reconnection, and helpers for custom events
- **Benchmark Harness**: Load-testing scripts to validate behaviour under pressure

## Repository Layout

```
├── backend/
│   ├── src/                 # Server source code
│   ├── dist/                # Compiled server output
│   ├── benchmark/           # Load testing scripts
│   ├── docs/                # Backend documentation
│   ├── examples/            # Presence server samples
│   ├── tsconfig.json        # Backend TypeScript config
│   └── vitest.config.mjs    # Backend test config
├── realtime-message-sdk/    # Browser SDK
├── package.json             # Workspace scripts
└── package-lock.json
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

## Quick Start (Backend)

```ts
import { createServer } from "http";
import { Server } from "socket.io";
import { Redis } from "ioredis";
import { initPresence } from "@YOUR_SCOPE/realtime-mesage";

const httpServer = createServer();
const io = new Server(httpServer);
const redis = new Redis("redis://localhost:6379");

await initPresence({ io, redis });

httpServer.listen(3000);
```

Presence cleanup is handled automatically when the Node.js process exits. For explicit shutdown (tests, graceful restarts) call `dispose()` on the returned runtime.

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

The `realtime-message-sdk/` package exposes a browser-friendly `RealtimeClient` with:

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
node backend/benchmark/presence-load-test.mjs
```

Environment variables such as `TARGET_URL`, `ROOM_COUNT`, and `HEARTBEATS_PER_SEC` control the workload. The script records latency percentiles, error counts, and presence events to help validate scale assumptions.

## License

[MIT](./LICENSE)
