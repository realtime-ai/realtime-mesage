# Presence Load Benchmark

This directory contains a standalone script that can stress the presence server by simulating many Socket.IO clients. The default scenario opens 100 rooms with 2 users each (200 concurrent sockets) and keeps them alive while each user emits 10 heartbeats per second.

## Prerequisites

- Node.js 18 or newer
- The presence server running and reachable (default `http://localhost:3000`)
- Install the Socket.IO client library once: `npm install --save-dev socket.io-client`

## Running the benchmark

```bash
npm run build              # optional: build the server
node benchmark/presence-load-test.mjs
```

Environment variables control the scenario:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_URL` | `http://localhost:3000` | Socket.IO endpoint to hit |
| `ROOM_COUNT` | `100` | Number of unique presence rooms |
| `USERS_PER_ROOM` | `2` | Concurrent users per room |
| `HEARTBEATS_PER_SEC` | `10` | Heartbeats dispatched by each user per second |
| `TEST_DURATION_MS` | `300000` | How long each user keeps sending heartbeats (ms) |
| `RAMP_UP_MS` | `60000` | Time window to bring all clients online (ms) |
| `REPORT_INTERVAL_MS` | `5000` | How often progress is printed |
| `ACK_TIMEOUT_MS` | `2000` | Timeout waiting for Socket.IO ACKs |

Example: run a 2 minute test against a remote host with faster heartbeats.

```bash
TARGET_URL=https://presence.example.com \
ROOM_COUNT=50 \
TEST_DURATION_MS=120000 \
HEARTBEATS_PER_SEC=20 \
node benchmark/presence-load-test.mjs
```

## Output

The script prints periodic progress reports and a final summary with latency percentiles and error counts. Exit code is non-zero if critical errors occurred or if the run was interrupted.

## Notes

- The script uses the Socket.IO protocol directly; no HTTP fallbacks are attempted.
- Each client reuses the epoch returned from the server to keep fencing semantics intact.
- Tune Redis and server resources before running large or repeated tests.
