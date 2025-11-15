/**
 * OpenTelemetry Setup and Initialization
 *
 * This module configures the OpenTelemetry SDK with:
 * - Trace provider with OTLP and console exporters
 * - Metrics provider with Prometheus and OTLP exporters
 * - Resource detection (service name, version, environment)
 * - Context propagation (W3C Trace Context)
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import type { TracingConfig } from "./types";

let sdk: NodeSDK | null = null;
let isInitialized = false;

/**
 * Initialize OpenTelemetry tracing and metrics with smart defaults
 *
 * @example
 * // Minimal setup - just enable tracing
 * initTracing();
 *
 * @example
 * // Production setup with custom endpoint
 * initTracing({
 *   otlpEndpoint: "http://your-collector:4318"
 * });
 */
export function initTracing(config: TracingConfig = {}): void {
  if (isInitialized) {
    console.warn("Tracing already initialized, skipping...");
    return;
  }

  // Smart defaults with environment variable fallbacks
  const environment = config.environment || process.env.NODE_ENV || "development";
  const isDevelopment = environment === "development";

  const {
    serviceName = process.env.OTEL_SERVICE_NAME || "realtime-presence-service",
    version = process.env.npm_package_version || "1.0.0",
    enabled = process.env.OTEL_ENABLED !== "false", // Enabled by default, disable with OTEL_ENABLED=false
    samplingRate = Number(process.env.OTEL_SAMPLING_RATE) || (isDevelopment ? 1.0 : 0.1),
    otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
    consoleExport = isDevelopment, // Auto-enable console export in development
    enableMetrics = true,
    metricsExportIntervalMs = 60000,
    enableRedisInstrumentation = true,
  } = config;

  if (!enabled) {
    console.log("Tracing is disabled");
    return;
  }

  // Enable diagnostic logging in development
  if (environment === "development" || consoleExport) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  // Define resource attributes
  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: version,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
  });

  // Configure trace exporters
  const traceExporters = [];

  // OTLP exporter for production backends (Jaeger, Tempo, etc.)
  traceExporters.push(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
      })
    )
  );

  // Console exporter for debugging
  if (consoleExport) {
    traceExporters.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  // Configure metric exporters
  const metricReaders = [];

  if (enableMetrics) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${otlpEndpoint}/v1/metrics`,
        }),
        exportIntervalMillis: metricsExportIntervalMs,
      })
    );
  }

  // Configure instrumentations
  const instrumentations = [
    // Auto-instrument common libraries
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": {
        enabled: false, // Disable filesystem instrumentation (too noisy)
      },
      "@opentelemetry/instrumentation-http": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-express": {
        enabled: false, // We don't use Express
      },
    }),
  ];

  // Add Redis instrumentation if enabled
  if (enableRedisInstrumentation) {
    instrumentations.push(
      new IORedisInstrumentation({
        // Capture Redis command arguments (be careful with sensitive data)
        dbStatementSerializer: (cmdName, cmdArgs) => {
          // Only capture first 3 arguments to avoid logging large payloads
          const safeArgs = cmdArgs.slice(0, 3).map((arg) => {
            if (typeof arg === "string" && arg.length > 100) {
              return arg.substring(0, 100) + "...";
            }
            return arg;
          });
          return `${cmdName} ${safeArgs.join(" ")}`;
        },
      })
    );
  }

  // Initialize the SDK
  sdk = new NodeSDK({
    resource,
    spanProcessors: traceExporters,
    metricReader: metricReaders.length > 0 ? metricReaders[0] : undefined,
    instrumentations,
    // Use W3C Trace Context for context propagation
    // This allows trace context to flow across service boundaries
  });

  try {
    sdk.start();
    isInitialized = true;
    console.log(
      `OpenTelemetry initialized for ${serviceName} (${environment}) - OTLP endpoint: ${otlpEndpoint}`
    );
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
  }

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await shutdownTracing();
  });
}

/**
 * Shutdown OpenTelemetry SDK gracefully
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk && isInitialized) {
    try {
      await sdk.shutdown();
      console.log("OpenTelemetry shutdown complete");
      isInitialized = false;
      sdk = null;
    } catch (error) {
      console.error("Error shutting down OpenTelemetry:", error);
    }
  }
}

/**
 * Check if tracing is initialized
 */
export function isTracingInitialized(): boolean {
  return isInitialized;
}
