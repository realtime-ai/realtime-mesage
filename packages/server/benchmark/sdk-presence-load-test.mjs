#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Import SDK from built dist
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sdkPath = join(__dirname, "../../sdk/dist/index.js");

const { RealtimeClient } = await import(sdkPath);

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:3000";
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT ?? "10", 10);
const USERS_PER_ROOM = parseInt(process.env.USERS_PER_ROOM ?? "2", 10);
const HEARTBEATS_PER_SEC = parseInt(
  process.env.HEARTBEATS_PER_SEC ?? "1",
  10
);
const TEST_DURATION_MS = parseInt(process.env.TEST_DURATION_MS ?? "60000", 10);
const RAMP_UP_MS = parseInt(process.env.RAMP_UP_MS ?? "10000", 10);
const REPORT_INTERVAL_MS = parseInt(
  process.env.REPORT_INTERVAL_MS ?? "5000",
  10
);

const TOTAL_CLIENTS = ROOM_COUNT * USERS_PER_ROOM;
const HEARTBEAT_INTERVAL_MS = Math.max(1000, Math.round(1000 / HEARTBEATS_PER_SEC));

const metrics = createMetrics();
let globalStop = false;
const startTime = Date.now();

process.on("SIGINT", () => {
  if (!globalStop) {
    console.warn("\nReceived SIGINT. Wrapping up... (press Ctrl+C again to exit immediately)");
    globalStop = true;
  } else {
    process.exit(1);
  }
});

const progressTimer = setInterval(() => {
  printProgress();
}, REPORT_INTERVAL_MS);
progressTimer.unref();

(async () => {
  console.log(
    `Starting SDK presence load: ${TOTAL_CLIENTS} clients across ${ROOM_COUNT} rooms, ` +
      `${HEARTBEATS_PER_SEC} heartbeats/s per user targeting ${TARGET_URL}`
  );
  console.log(`Using rtm-sdk with built-in presence API`);

  const tasks = Array.from({ length: TOTAL_CLIENTS }, (_v, index) => runClient(index));
  await Promise.allSettled(tasks);
  clearInterval(progressTimer);
  printSummary();

  if (globalStop || metrics.errorsTotal > 0) {
    process.exitCode = 1;
  }
})().catch((error) => {
  clearInterval(progressTimer);
  console.error("Fatal error in benchmark", error);
  process.exit(1);
});

function createMetrics() {
  return {
    connectLatency: new StatsCollector(),
    joinLatency: new StatsCollector(),
    heartbeatLatency: new StatsCollector(),
    connectSuccess: 0,
    joinSuccess: 0,
    heartbeatSuccess: 0,
    leaveSuccess: 0,
    heartbeatsAttempted: 0,
    eventsReceived: 0,
    joinSnapshotTotal: 0,
    errors: {
      connect: 0,
      join: 0,
      heartbeat: 0,
      leave: 0,
    },
    get errorsTotal() {
      return (
        this.errors.connect +
        this.errors.join +
        this.errors.heartbeat +
        this.errors.leave
      );
    },
  };
}

class StatsCollector {
  constructor() {
    this.values = [];
  }

  record(value) {
    this.values.push(value);
  }

  summary() {
    if (this.values.length === 0) {
      return null;
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const percentile = (p) => {
      if (count === 0) return 0;
      const rank = Math.min(count - 1, Math.max(0, Math.round((p / 100) * (count - 1))));
      return sorted[rank];
    };
    return {
      count,
      min: sorted[0],
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      max: sorted[count - 1],
      avg: sum / count,
    };
  }
}

async function runClient(clientIndex) {
  const roomIndex = Math.floor(clientIndex / USERS_PER_ROOM);
  const userIndex = clientIndex % USERS_PER_ROOM;
  const roomId = `room-${String(roomIndex + 1).padStart(3, "0")}`;
  const userId = `user-${String(roomIndex + 1).padStart(3, "0")}-${userIndex + 1}`;
  const rampDelay = Math.floor((clientIndex / TOTAL_CLIENTS) * RAMP_UP_MS);

  await sleep(rampDelay);
  if (globalStop) {
    return;
  }

  let client;
  let channel;

  try {
    // Create client with SDK
    const connectStart = performance.now();
    client = new RealtimeClient({
      baseUrl: TARGET_URL,
      reconnection: false,
      presence: {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      },
    });

    await client.connect();
    const connectLatency = performance.now() - connectStart;
    metrics.connectSuccess += 1;
    metrics.connectLatency.record(connectLatency);
  } catch (error) {
    metrics.errors.connect += 1;
    debugLog(`connect_failed ${roomId}/${userId}: ${error.message}`);
    return;
  }

  // Track presence events
  let eventCount = 0;

  try {
    // Join room using built-in presence API
    const joinStart = performance.now();
    const { channel: ch, response } = await client.joinRoom({
      roomId,
      userId,
      state: { clientIndex, startedAt: Date.now() },
    });

    const joinLatency = performance.now() - joinStart;

    if (!response.ok) {
      metrics.errors.join += 1;
      debugLog(`join_rejected ${roomId}/${userId}: ${response.error}`);
      await client.disconnect();
      return;
    }

    channel = ch;
    metrics.joinSuccess += 1;
    metrics.joinLatency.record(joinLatency);
    metrics.joinSnapshotTotal += response.snapshot?.length ?? 0;

    // Listen for presence events
    channel.on("presenceEvent", () => {
      eventCount += 1;
      metrics.eventsReceived += 1;
    });

    debugLog(`joined ${roomId}/${userId} in ${joinLatency.toFixed(2)}ms`);
  } catch (error) {
    metrics.errors.join += 1;
    debugLog(`join_error ${roomId}/${userId}: ${error.message}`);
    await client.disconnect();
    return;
  }

  // Send heartbeats
  const deadline = Date.now() + TEST_DURATION_MS;
  let seq = 0;

  while (!globalStop && client.isConnected() && Date.now() < deadline) {
    try {
      const hbStart = performance.now();
      await channel.updateState({
        seq,
        ts: Date.now(),
      });

      const hbLatency = performance.now() - hbStart;
      metrics.heartbeatsAttempted += 1;
      metrics.heartbeatSuccess += 1;
      metrics.heartbeatLatency.record(hbLatency);

      seq += 1;
    } catch (error) {
      metrics.errors.heartbeat += 1;
      debugLog(`heartbeat_error ${roomId}/${userId}: ${error.message}`);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(HEARTBEAT_INTERVAL_MS, remaining));
    }
  }

  // Leave room
  try {
    await channel.leave();
    metrics.leaveSuccess += 1;
  } catch (error) {
    metrics.errors.leave += 1;
    debugLog(`leave_error ${roomId}/${userId}: ${error.message}`);
  }

  await client.disconnect();
  debugLog(`client ${roomId}/${userId} finished (events received: ${eventCount})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printProgress() {
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(
    `[${elapsed.toFixed(1)}s] connected=${metrics.connectSuccess}/${TOTAL_CLIENTS} ` +
      `joined=${metrics.joinSuccess}/${TOTAL_CLIENTS} ` +
      `heartbeat_ok=${metrics.heartbeatSuccess}/${metrics.heartbeatsAttempted} ` +
      `events=${metrics.eventsReceived} errors=${metrics.errorsTotal}`
  );
}

function printSummary() {
  const elapsedMs = Date.now() - startTime;
  console.log("\nSDK Load test summary");
  console.log(`Duration: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Clients: ${TOTAL_CLIENTS} (rooms=${ROOM_COUNT}, users/room=${USERS_PER_ROOM})`);
  console.log(`Connect successes: ${metrics.connectSuccess}`);
  console.log(`Join successes: ${metrics.joinSuccess}`);
  console.log(`Heartbeats attempted: ${metrics.heartbeatsAttempted}`);
  console.log(`Heartbeat successes: ${metrics.heartbeatSuccess}`);
  console.log(`Leave successes: ${metrics.leaveSuccess}`);
  console.log(`Presence events received: ${metrics.eventsReceived}`);
  console.log(`Join snapshot total size: ${metrics.joinSnapshotTotal}`);
  console.log("Errors:", metrics.errors);

  const connectSummary = metrics.connectLatency.summary();
  if (connectSummary) {
    console.log("Connect latency (ms):", formatSummary(connectSummary));
  }

  const joinSummary = metrics.joinLatency.summary();
  if (joinSummary) {
    console.log("Join latency (ms):", formatSummary(joinSummary));
  }

  const heartbeatSummary = metrics.heartbeatLatency.summary();
  if (heartbeatSummary) {
    console.log("Heartbeat latency (ms):", formatSummary(heartbeatSummary));
  }
}

function formatSummary(summary) {
  const parts = [
    `count=${summary.count}`,
    `min=${summary.min.toFixed(2)}`,
    `p50=${summary.p50.toFixed(2)}`,
    `p90=${summary.p90.toFixed(2)}`,
    `p95=${summary.p95.toFixed(2)}`,
    `p99=${summary.p99.toFixed(2)}`,
    `max=${summary.max.toFixed(2)}`,
    `avg=${summary.avg.toFixed(2)}`,
  ];
  return parts.join(", ");
}

function debugLog(message) {
  if (process.env.BENCHMARK_DEBUG) {
    console.debug(`[debug] ${message}`);
  }
}
