# Benchmarks

This directory contains performance benchmarks for the realtime message infrastructure.

## Available Benchmarks

### 1. `presence-load-test.mjs` - Low-level Protocol Benchmark

Tests the server's presence protocol implementation directly using Socket.IO client.

**Purpose:**
- Measure raw server performance without SDK overhead
- Test server under extreme load conditions
- Validate presence protocol correctness at scale

**Usage:**
```bash
npm run benchmark:presence

# With custom parameters
ROOM_COUNT=100 USERS_PER_ROOM=5 npm run benchmark:presence
```

**Environment Variables:**
- `TARGET_URL` - Server URL (default: `http://localhost:3000`)
- `ROOM_COUNT` - Number of rooms (default: `100`)
- `USERS_PER_ROOM` - Users per room (default: `2`)
- `HEARTBEATS_PER_SEC` - Heartbeats per second per user (default: `10`)
- `TEST_DURATION_MS` - Test duration in milliseconds (default: `300000` = 5 minutes)
- `RAMP_UP_MS` - Ramp-up time in milliseconds (default: `60000` = 1 minute)
- `REPORT_INTERVAL_MS` - Progress report interval (default: `5000`)
- `ACK_TIMEOUT_MS` - Acknowledgement timeout (default: `2000`)
- `BENCHMARK_DEBUG` - Enable debug logging (default: disabled)

**Example:**
```bash
# Quick test: 10 rooms, 2 users each, 1 minute duration
ROOM_COUNT=10 TEST_DURATION_MS=60000 npm run benchmark:presence

# Stress test: 200 rooms, 10 users each
ROOM_COUNT=200 USERS_PER_ROOM=10 npm run benchmark:presence
```

### 2. `sdk-presence-load-test.mjs` - SDK Benchmark

Tests the SDK's presence API implementation (including built-in presence).

**Purpose:**
- Measure SDK performance and overhead
- Test the new built-in presence API (`client.joinRoom()`)
- Validate SDK behavior under load

**Usage:**
```bash
# Build SDK first
npm run build:sdk

# Run SDK benchmark
npm run benchmark:sdk

# With custom parameters
ROOM_COUNT=10 USERS_PER_ROOM=2 npm run benchmark:sdk
```

**Environment Variables:**
- `TARGET_URL` - Server URL (default: `http://localhost:3000`)
- `ROOM_COUNT` - Number of rooms (default: `10`)
- `USERS_PER_ROOM` - Users per room (default: `2`)
- `HEARTBEATS_PER_SEC` - Heartbeats per second per user (default: `1`)
- `TEST_DURATION_MS` - Test duration in milliseconds (default: `60000` = 1 minute)
- `RAMP_UP_MS` - Ramp-up time in milliseconds (default: `10000`)
- `REPORT_INTERVAL_MS` - Progress report interval (default: `5000`)
- `BENCHMARK_DEBUG` - Enable debug logging (default: disabled)

**Example:**
```bash
# Quick test with SDK
ROOM_COUNT=5 TEST_DURATION_MS=30000 npm run benchmark:sdk
```

## Comparison

| Feature | `presence-load-test.mjs` | `sdk-presence-load-test.mjs` |
|---------|-------------------------|------------------------------|
| **Target** | Server protocol | SDK API |
| **Client** | Raw Socket.IO client | realtime-message-sdk RealtimeClient |
| **Overhead** | Minimal | Includes SDK overhead |
| **Default Load** | High (100 rooms, 10 hb/s) | Moderate (10 rooms, 1 hb/s) |
| **Use Case** | Server stress testing | SDK integration testing |

## Typical Workflow

1. **Start the server:**
   ```bash
   npm run dev
   ```

2. **Run low-level benchmark** to validate server performance:
   ```bash
   npm run benchmark:presence
   ```

3. **Build SDK** if not already built:
   ```bash
   npm run build:sdk
   ```

4. **Run SDK benchmark** to validate SDK behavior:
   ```bash
   npm run benchmark:sdk
   ```

## Interpreting Results

### Metrics

Both benchmarks report:
- **Connect/Join success rate** - Should be close to 100%
- **Heartbeat success rate** - Should be close to 100%
- **Latency percentiles** (p50, p90, p95, p99) - Lower is better
  - p50 < 10ms: Excellent
  - p50 < 50ms: Good
  - p50 < 100ms: Acceptable
  - p50 > 100ms: Investigate performance issues
- **Events received** - Should match expected presence events
- **Errors** - Should be zero or minimal

### Example Output

```
Starting SDK presence load: 20 clients across 10 rooms, 1 heartbeats/s per user
Using realtime-message-sdk with built-in presence API
[5.0s] connected=20/20 joined=20/20 heartbeat_ok=85/85 events=180 errors=0

SDK Load test summary
Duration: 60.5s
Clients: 20 (rooms=10, users/room=2)
Connect successes: 20
Join successes: 20
Heartbeats attempted: 1200
Heartbeat successes: 1200
Presence events received: 2400
Errors: { connect: 0, join: 0, heartbeat: 0, leave: 0 }
Connect latency (ms): count=20, min=15.23, p50=18.45, p90=22.11, p95=24.32, p99=28.91, max=30.12, avg=19.34
Join latency (ms): count=20, min=8.12, p50=10.23, p90=12.45, p95=13.21, p99=15.67, max=16.89, avg=10.87
Heartbeat latency (ms): count=1200, min=2.34, p50=4.56, p90=6.78, p95=7.89, p99=9.12, max=12.34, avg=5.12
```

## Troubleshooting

### High Error Rates

If you see high error rates:
1. Check server logs for errors
2. Reduce load (fewer rooms or users)
3. Increase `ACK_TIMEOUT_MS`
4. Ensure Redis is running and healthy

### High Latencies

If latencies are high:
1. Check server CPU and memory usage
2. Check Redis performance (`redis-cli --latency`)
3. Reduce concurrent load
4. Optimize server configuration (connection pools, etc.)

### Connection Failures

If clients fail to connect:
1. Verify server is running (`npm run dev`)
2. Check `TARGET_URL` is correct
3. Check firewall/network settings
4. Review server logs for errors
