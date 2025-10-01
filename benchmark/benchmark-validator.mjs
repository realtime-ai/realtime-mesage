#!/usr/bin/env node
/**
 * Benchmark Validator
 *
 * Runs performance benchmarks and validates results against thresholds.
 * Exits with non-zero code if any threshold is violated.
 *
 * Environment Variables:
 * - MAX_ERROR_RATE: Maximum allowed error rate (default: 0.01 = 1%)
 * - MAX_P95_LATENCY_MS: Maximum p95 latency in ms (default: 150)
 * - MAX_P99_LATENCY_MS: Maximum p99 latency in ms (default: 300)
 * - MIN_SUCCESS_RATE: Minimum success rate (default: 0.99 = 99%)
 */

import { spawn } from "node:child_process";
import process from "node:process";

const MAX_ERROR_RATE = parseFloat(process.env.MAX_ERROR_RATE ?? "0.01");
const MAX_P95_LATENCY_MS = parseInt(process.env.MAX_P95_LATENCY_MS ?? "150", 10);
const MAX_P99_LATENCY_MS = parseInt(process.env.MAX_P99_LATENCY_MS ?? "300", 10);
const MIN_SUCCESS_RATE = parseFloat(process.env.MIN_SUCCESS_RATE ?? "0.99");

const thresholds = {
  maxErrorRate: MAX_ERROR_RATE,
  maxP95LatencyMs: MAX_P95_LATENCY_MS,
  maxP99LatencyMs: MAX_P99_LATENCY_MS,
  minSuccessRate: MIN_SUCCESS_RATE,
};

console.log("Benchmark Validator");
console.log("===================");
console.log("Thresholds:");
console.log(`  Max Error Rate: ${(thresholds.maxErrorRate * 100).toFixed(2)}%`);
console.log(`  Max P95 Latency: ${thresholds.maxP95LatencyMs}ms`);
console.log(`  Max P99 Latency: ${thresholds.maxP99LatencyMs}ms`);
console.log(`  Min Success Rate: ${(thresholds.minSuccessRate * 100).toFixed(2)}%`);
console.log();

// Run the benchmark
const benchmarkScript = process.argv[2] ?? "./benchmark/presence-load-test.mjs";
console.log(`Running benchmark: ${benchmarkScript}`);
console.log();

const benchmarkProcess = spawn("node", [benchmarkScript], {
  stdio: "pipe",
  env: process.env,
});

let output = "";
let summaryStarted = false;
let metrics = {};

benchmarkProcess.stdout.on("data", (data) => {
  const text = data.toString();
  process.stdout.write(text);
  output += text;

  if (text.includes("Load test summary")) {
    summaryStarted = true;
  }
});

benchmarkProcess.stderr.on("data", (data) => {
  process.stderr.write(data);
});

benchmarkProcess.on("close", (code) => {
  if (code !== 0 && code !== 1) {
    console.error(`\nBenchmark exited with code ${code}`);
    process.exit(code);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Validation Results");
  console.log("=".repeat(60) + "\n");

  // Parse metrics from output
  metrics = parseMetrics(output);

  const violations = [];

  // Check error rate
  if (metrics.totalAttempts > 0) {
    const errorRate = metrics.totalErrors / metrics.totalAttempts;
    const passed = errorRate <= thresholds.maxErrorRate;
    console.log(
      `${passed ? "✓" : "✗"} Error Rate: ${(errorRate * 100).toFixed(2)}% ` +
        `(threshold: ${(thresholds.maxErrorRate * 100).toFixed(2)}%)`
    );
    if (!passed) {
      violations.push(`Error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold`);
    }
  }

  // Check success rate
  if (metrics.totalAttempts > 0) {
    const successRate = metrics.totalSuccesses / metrics.totalAttempts;
    const passed = successRate >= thresholds.minSuccessRate;
    console.log(
      `${passed ? "✓" : "✗"} Success Rate: ${(successRate * 100).toFixed(2)}% ` +
        `(threshold: ${(thresholds.minSuccessRate * 100).toFixed(2)}%)`
    );
    if (!passed) {
      violations.push(`Success rate ${(successRate * 100).toFixed(2)}% below threshold`);
    }
  }

  // Check P95 latency
  if (metrics.joinP95 !== null) {
    const passed = metrics.joinP95 <= thresholds.maxP95LatencyMs;
    console.log(
      `${passed ? "✓" : "✗"} Join P95 Latency: ${metrics.joinP95.toFixed(2)}ms ` +
        `(threshold: ${thresholds.maxP95LatencyMs}ms)`
    );
    if (!passed) {
      violations.push(`Join P95 latency ${metrics.joinP95.toFixed(2)}ms exceeds threshold`);
    }
  }

  if (metrics.heartbeatP95 !== null) {
    const passed = metrics.heartbeatP95 <= thresholds.maxP95LatencyMs;
    console.log(
      `${passed ? "✓" : "✗"} Heartbeat P95 Latency: ${metrics.heartbeatP95.toFixed(2)}ms ` +
        `(threshold: ${thresholds.maxP95LatencyMs}ms)`
    );
    if (!passed) {
      violations.push(
        `Heartbeat P95 latency ${metrics.heartbeatP95.toFixed(2)}ms exceeds threshold`
      );
    }
  }

  // Check P99 latency
  if (metrics.joinP99 !== null) {
    const passed = metrics.joinP99 <= thresholds.maxP99LatencyMs;
    console.log(
      `${passed ? "✓" : "✗"} Join P99 Latency: ${metrics.joinP99.toFixed(2)}ms ` +
        `(threshold: ${thresholds.maxP99LatencyMs}ms)`
    );
    if (!passed) {
      violations.push(`Join P99 latency ${metrics.joinP99.toFixed(2)}ms exceeds threshold`);
    }
  }

  if (metrics.heartbeatP99 !== null) {
    const passed = metrics.heartbeatP99 <= thresholds.maxP99LatencyMs;
    console.log(
      `${passed ? "✓" : "✗"} Heartbeat P99 Latency: ${metrics.heartbeatP99.toFixed(2)}ms ` +
        `(threshold: ${thresholds.maxP99LatencyMs}ms)`
    );
    if (!passed) {
      violations.push(
        `Heartbeat P99 latency ${metrics.heartbeatP99.toFixed(2)}ms exceeds threshold`
      );
    }
  }

  console.log();

  if (violations.length > 0) {
    console.error("❌ Validation FAILED");
    console.error("\nViolations:");
    violations.forEach((v) => console.error(`  - ${v}`));
    process.exit(1);
  } else {
    console.log("✅ Validation PASSED");
    console.log("All metrics are within acceptable thresholds.");
    process.exit(0);
  }
});

function parseMetrics(output) {
  const metrics = {
    totalAttempts: 0,
    totalSuccesses: 0,
    totalErrors: 0,
    joinP95: null,
    joinP99: null,
    heartbeatP95: null,
    heartbeatP99: null,
  };

  // Parse total attempts and successes
  const heartbeatMatch = output.match(/Heartbeats attempted: (\d+)/);
  const heartbeatSuccessMatch = output.match(/Heartbeat successes: (\d+)/);
  const joinSuccessMatch = output.match(/joined=(\d+)/);

  if (heartbeatMatch) {
    metrics.totalAttempts = parseInt(heartbeatMatch[1], 10);
  }

  if (heartbeatSuccessMatch) {
    metrics.totalSuccesses = parseInt(heartbeatSuccessMatch[1], 10);
  }

  // Parse errors from errors object
  const errorsMatch = output.match(/Errors: ({[^}]+})/);
  if (errorsMatch) {
    try {
      const errorsStr = errorsMatch[1]
        .replace(/(\w+):/g, '"$1":')
        .replace(/'/g, '"');
      const errors = JSON.parse(errorsStr);
      metrics.totalErrors = Object.values(errors).reduce(
        (sum, val) => sum + (typeof val === "number" ? val : 0),
        0
      );
    } catch (e) {
      // Fallback: try to extract individual error counts
      const errorCounts = output.match(/(\w+): (\d+)/g);
      if (errorCounts) {
        metrics.totalErrors = errorCounts
          .map((m) => {
            const match = m.match(/: (\d+)/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .reduce((sum, val) => sum + val, 0);
      }
    }
  }

  // Parse latency percentiles
  const joinLatencyMatch = output.match(/Join latency \(ms\): ([^\n]+)/);
  if (joinLatencyMatch) {
    const p95Match = joinLatencyMatch[1].match(/p95=([\d.]+)/);
    const p99Match = joinLatencyMatch[1].match(/p99=([\d.]+)/);
    if (p95Match) metrics.joinP95 = parseFloat(p95Match[1]);
    if (p99Match) metrics.joinP99 = parseFloat(p99Match[1]);
  }

  const heartbeatLatencyMatch = output.match(/Heartbeat latency \(ms\): ([^\n]+)/);
  if (heartbeatLatencyMatch) {
    const p95Match = heartbeatLatencyMatch[1].match(/p95=([\d.]+)/);
    const p99Match = heartbeatLatencyMatch[1].match(/p99=([\d.]+)/);
    if (p95Match) metrics.heartbeatP95 = parseFloat(p95Match[1]);
    if (p99Match) metrics.heartbeatP99 = parseFloat(p99Match[1]);
  }

  return metrics;
}
