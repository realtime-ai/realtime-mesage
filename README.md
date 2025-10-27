# Realtime Message Infrastructure

A modular realtime message infrastructure built on Socket.IO and Redis. Provides core messaging capabilities with built-in presence orchestration, designed for extensibility through pluggable modules.

## Features

- **Modular Architecture**: Pluggable module system for extending functionality
- **Built-in Presence**: Production-ready presence orchestration with epoch-based fencing and TTL expiry
- **Direct API Access**: Modules have direct access to Socket.IO and Redis without abstraction layers
- **Multi-node Support**: Redis adapter keeps multiple Socket.IO nodes in sync
- **TypeScript SDK**: Browser client (`@realtime-mesage/sdk`) with automatic heartbeats and reconnection
- **Load Testing**: Benchmark harness to validate scale assumptions
- **Monorepo Structure**: Clean separation between server and SDK packages using pnpm workspaces

## Repository Layout

```
├── packages/
│   ├── server/           # Server package (@realtime-mesage/server)
│   │   ├── src/
│   │   │   ├── core/     # Core framework (RealtimeServer, module system)
│   │   │   ├── modules/presence/  # Built-in presence module
│   │   │   ├── server.ts # Server entry point
│   │   │   └── config.ts # Configuration
│   │   ├── examples/     # Custom module examples
│   │   └── benchmark/    # Load testing
│   └── sdk/              # Browser SDK package (@realtime-mesage/sdk)
│       ├── src/
│       │   ├── core/     # Client core
│       │   └── modules/presence/  # Presence channel
│       ├── examples/     # SDK usage examples
│       └── demo/         # Interactive demo
├── package.json          # Workspace root
└── pnpm-workspace.yaml   # Workspace configuration
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+ (recommended) or npm with workspaces
- Redis 6+ (single instance or cluster)

### Installation

```bash
pnpm install
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
pnpm dev
```

Production build & run:

```bash
pnpm build
pnpm start
```

### Testing

Run all tests:

```bash
pnpm test
```

Run specific package tests:

```bash
pnpm test:server  # Server tests only
pnpm test:sdk     # SDK tests only
pnpm test:e2e     # E2E integration tests (requires Redis)
```

## Extending with Custom Modules

The modular architecture allows you to add custom features (chat, notifications, analytics, etc.) without modifying core code.

See `packages/server/examples/custom-chat-module/` for a complete working example, or refer to [CLAUDE.md](./CLAUDE.md#creating-custom-modules) for detailed module development guide.

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

The `@realtime-mesage/sdk` package (`packages/sdk/`) exposes a browser-friendly `RealtimeClient` with:

- Automatic heartbeat scheduling and fencing-aware acknowledgements
- `emit`/`on` helpers that mirror Socket.IO's API for custom application events
- Type-safe presence responses and event payloads
- A demo playground for manual testing

Build the SDK and launch the demo:

```bash
pnpm build:sdk
pnpm sdk:demo
```

Visit <http://localhost:4173> to join a room, send presence heartbeats, and experiment with custom events.

See `packages/sdk/README.md` for detailed SDK documentation and usage examples.

## Load Testing

Simulate 100 rooms × 2 users (or any custom scenario) with the benchmark script:

```bash
pnpm build:sdk   # optional, if you want fresh dist assets
pnpm benchmark:presence
```

Environment variables such as `TARGET_URL`, `ROOM_COUNT`, and `HEARTBEATS_PER_SEC` control the workload. The script records latency percentiles, error counts, and presence events to help validate scale assumptions.

## License

[MIT](./LICENSE)
