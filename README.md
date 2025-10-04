# Realtime Message Infrastructure

A modular realtime message infrastructure built on Socket.IO and Redis. Provides core messaging capabilities with built-in presence orchestration, designed for extensibility through pluggable modules.

## Features

- **Modular Architecture**: Pluggable module system for extending functionality
- **Built-in Presence**: Production-ready presence orchestration with epoch-based fencing and TTL expiry
- **Direct API Access**: Modules have direct access to Socket.IO and Redis without abstraction layers
- **Multi-node Support**: Redis adapter keeps multiple Socket.IO nodes in sync
- **TypeScript SDK**: Browser client (`rtm-sdk/`) with automatic heartbeats and reconnection
- **Load Testing**: Benchmark harness to validate scale assumptions

## Repository Layout

```
├── src/
│   ├── core/             # Core framework (RealtimeServer, module system)
│   ├── modules/presence/ # Built-in presence module
│   ├── server.ts         # Server entry point
│   └── config.ts         # Configuration
├── rtm-sdk/              # Browser SDK
├── examples/             # Custom module examples
├── benchmark/            # Load testing
└── package.json          # Workspace scripts
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

## Extending with Custom Modules

The modular architecture allows you to add custom features (chat, notifications, analytics, etc.) without modifying core code.

See `examples/custom-chat-module/` for a complete working example, or refer to [CLAUDE.md](./CLAUDE.md#creating-custom-modules) for detailed module development guide.

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
