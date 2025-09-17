#!/usr/bin/env node
import { io } from "socket.io-client";
import { performance } from "node:perf_hooks";
import process from "node:process";

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:3000";
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT ?? "100", 10);
const USERS_PER_ROOM = parseInt(process.env.USERS_PER_ROOM ?? "2", 10);
const HEARTBEATS_PER_SEC = parseInt(
  process.env.HEARTBEATS_PER_SEC ?? "10",
  10
);
const TEST_DURATION_MS = parseInt(process.env.TEST_DURATION_MS ?? "300000", 10);
const RAMP_UP_MS = parseInt(process.env.RAMP_UP_MS ?? "60000", 10);
const REPORT_INTERVAL_MS = parseInt(
  process.env.REPORT_INTERVAL_MS ?? "5000",
  10
);
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS ?? "2000", 10);

const TOTAL_CLIENTS = ROOM_COUNT * USERS_PER_ROOM;
const HEARTBEAT_INTERVAL_MS = Math.max(1, Math.round(1000 / HEARTBEATS_PER_SEC));

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
    `Starting presence load: ${TOTAL_CLIENTS} clients across ${ROOM_COUNT} rooms, ` +
      `${HEARTBEATS_PER_SEC} heartbeats/s per user targeting ${TARGET_URL}`
  );

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
    joinLatency: new StatsCollector(),
    heartbeatLatency: new StatsCollector(),
    joinSuccess: 0,
    heartbeatSuccess: 0,
    leaveSuccess: 0,
    heartbeatsAttempted: 0,
    eventsReceived: 0,
    joinSnapshotTotal: 0,
    errors: {
      connect: 0,
      joinTimeout: 0,
      joinRejected: 0,
      heartbeatTimeout: 0,
      heartbeatRejected: 0,
      leave: 0,
    },
    get errorsTotal() {
      return (
        this.errors.connect +
        this.errors.joinTimeout +
        this.errors.joinRejected +
        this.errors.heartbeatTimeout +
        this.errors.heartbeatRejected +
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

  let socket;
  try {
    socket = await connectSocket(TARGET_URL, roomId, userId);
  } catch (error) {
    metrics.errors.connect += 1;
    debugLog(`connect_failed ${roomId}/${userId}: ${error.message}`);
    return;
  }

  let connected = true;
  socket.on("disconnect", (reason) => {
    connected = false;
    debugLog(`disconnect ${roomId}/${userId}: ${reason}`);
  });
  socket.on("presence:event", () => {
    metrics.eventsReceived += 1;
  });

  let epoch;
  try {
    const joinPayload = {
      roomId,
      userId,
      state: { clientIndex, startedAt: Date.now() },
    };
    const joinResult = await emitWithAck(socket, "presence:join", joinPayload, ACK_TIMEOUT_MS);
    if (joinResult.status !== "ack") {
      metrics.errors.joinTimeout += 1;
      debugLog(`join_timeout ${roomId}/${userId}`);
      socket.disconnect();
      return;
    }
    const response = joinResult.response ?? {};
    if (!response.ok) {
      metrics.errors.joinRejected += 1;
      debugLog(`join_rejected ${roomId}/${userId}: ${JSON.stringify(response)}`);
      socket.disconnect();
      return;
    }
    metrics.joinSuccess += 1;
    metrics.joinSnapshotTotal += Array.isArray(response.snapshot)
      ? response.snapshot.length
      : 0;
    metrics.joinLatency.record(joinResult.latency);
    epoch = response.self?.epoch;
  } catch (error) {
    metrics.errors.joinRejected += 1;
    debugLog(`join_error ${roomId}/${userId}: ${error.message}`);
    socket.disconnect();
    return;
  }

  const deadline = Date.now() + TEST_DURATION_MS;
  let seq = 0;
  while (!globalStop && connected && Date.now() < deadline) {
    const payload = {
      patchState: {
        seq,
        roomId,
        userId,
        ts: Date.now(),
      },
      epoch,
    };

    metrics.heartbeatsAttempted += 1;
    const hbResult = await emitWithAck(
      socket,
      "presence:heartbeat",
      payload,
      ACK_TIMEOUT_MS
    );

    if (hbResult.status === "ack") {
      const response = hbResult.response ?? {};
      if (response.ok) {
        metrics.heartbeatSuccess += 1;
        metrics.heartbeatLatency.record(hbResult.latency);
        if (typeof response.epoch === "number") {
          epoch = response.epoch;
        }
      } else {
        metrics.errors.heartbeatRejected += 1;
      }
    } else {
      metrics.errors.heartbeatTimeout += 1;
    }

    seq += 1;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(HEARTBEAT_INTERVAL_MS, remaining));
    }
  }

  try {
    const leaveResult = await emitWithAck(socket, "presence:leave", null, ACK_TIMEOUT_MS);
    if (leaveResult.status === "ack" && leaveResult.response?.ok) {
      metrics.leaveSuccess += 1;
    } else {
      metrics.errors.leave += 1;
    }
  } catch (_error) {
    metrics.errors.leave += 1;
  }

  socket.disconnect();
}

function connectSocket(url, roomId, userId) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: 10000,
      query: {
        loadTestRoom: roomId,
        loadTestUser: userId,
      },
    });

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      socket.off("error", onError);
    };

    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const onError = (error) => {
      cleanup();
      socket.disconnect();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.once("error", onError);
  });
}

function emitWithAck(socket, event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("socket_disconnected"));
      return;
    }

    const start = performance.now();
    let completed = false;
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      resolve({ status: "timeout", latency: performance.now() - start });
    }, timeoutMs);

    try {
      socket.emit(event, payload, (response) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timer);
        resolve({ status: "ack", response, latency: performance.now() - start });
      });
    } catch (error) {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printProgress() {
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(
    `[${elapsed.toFixed(1)}s] joined=${metrics.joinSuccess}/${TOTAL_CLIENTS} ` +
      `heartbeat_ok=${metrics.heartbeatSuccess}/${metrics.heartbeatsAttempted} ` +
      `events=${metrics.eventsReceived} errors=${metrics.errorsTotal}`
  );
}

function printSummary() {
  const elapsedMs = Date.now() - startTime;
  console.log("\nLoad test summary");
  console.log(`Duration: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Clients: ${TOTAL_CLIENTS} (rooms=${ROOM_COUNT}, users/room=${USERS_PER_ROOM})`);
  console.log(`Heartbeats attempted: ${metrics.heartbeatsAttempted}`);
  console.log(`Heartbeat successes: ${metrics.heartbeatSuccess}`);
  console.log(`Presence events received: ${metrics.eventsReceived}`);
  console.log(`Join snapshot total size: ${metrics.joinSnapshotTotal}`);
  console.log("Errors:", metrics.errors);

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
