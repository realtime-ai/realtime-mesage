/**
 * OpenTelemetry Exporter Configurations for Popular Backends
 *
 * This file contains ready-to-use configurations for various tracing backends.
 * Uncomment the one you want to use and set the environment variables.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

/**
 * Configuration helper type
 */
interface ExporterConfig {
  traceExporter: OTLPTraceExporter;
  metricExporter?: OTLPMetricExporter;
}

/**
 * 1. Local Jaeger (default)
 * No registration needed, just run docker-compose
 */
export function createLocalJaegerExporter(): ExporterConfig {
  return {
    traceExporter: new OTLPTraceExporter({
      url: "http://localhost:4318/v1/traces",
    }),
    metricExporter: new OTLPMetricExporter({
      url: "http://localhost:4318/v1/metrics",
    }),
  };
}

/**
 * 2. SigNoz Cloud
 * Sign up: https://signoz.io/teams/
 * Free tier: 1GB/month
 */
export function createSigNozExporter(): ExporterConfig {
  const endpoint = process.env.SIGNOZ_ENDPOINT || "https://ingest.us.signoz.cloud:443";
  const token = process.env.SIGNOZ_ACCESS_TOKEN;

  if (!token) {
    throw new Error("SIGNOZ_ACCESS_TOKEN is required");
  }

  const headers = {
    "signoz-access-token": token,
  };

  return {
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    }),
    metricExporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
    }),
  };
}

/**
 * 3. Grafana Cloud
 * Sign up: https://grafana.com/auth/sign-up/create-user
 * Free tier: 50GB/month
 */
export function createGrafanaCloudExporter(): ExporterConfig {
  const instanceId = process.env.GRAFANA_INSTANCE_ID;
  const apiKey = process.env.GRAFANA_API_KEY;
  const region = process.env.GRAFANA_REGION || "prod-us-central-0";

  if (!instanceId || !apiKey) {
    throw new Error("GRAFANA_INSTANCE_ID and GRAFANA_API_KEY are required");
  }

  const auth = Buffer.from(`${instanceId}:${apiKey}`).toString("base64");
  const headers = {
    "Authorization": `Basic ${auth}`,
  };

  return {
    traceExporter: new OTLPTraceExporter({
      url: `https://otlp-gateway-${region}.grafana.net/otlp/v1/traces`,
      headers,
    }),
    metricExporter: new OTLPMetricExporter({
      url: `https://otlp-gateway-${region}.grafana.net/otlp/v1/metrics`,
      headers,
    }),
  };
}

/**
 * 4. Honeycomb
 * Sign up: https://ui.honeycomb.io/signup
 * Free tier: 20M events/month
 */
export function createHoneycombExporter(): ExporterConfig {
  const apiKey = process.env.HONEYCOMB_API_KEY;
  const dataset = process.env.HONEYCOMB_DATASET || "realtime-presence";

  if (!apiKey) {
    throw new Error("HONEYCOMB_API_KEY is required");
  }

  return {
    traceExporter: new OTLPTraceExporter({
      url: "https://api.honeycomb.io/v1/traces",
      headers: {
        "x-honeycomb-team": apiKey,
        "x-honeycomb-dataset": dataset,
      },
    }),
    metricExporter: new OTLPMetricExporter({
      url: "https://api.honeycomb.io/v1/metrics",
      headers: {
        "x-honeycomb-team": apiKey,
        "x-honeycomb-dataset": dataset,
      },
    }),
  };
}

/**
 * 5. New Relic
 * Sign up: https://newrelic.com/signup
 * Free tier: 100GB/month
 */
export function createNewRelicExporter(): ExporterConfig {
  const licenseKey = process.env.NEW_RELIC_LICENSE_KEY;
  const region = process.env.NEW_RELIC_REGION || "US"; // US or EU

  if (!licenseKey) {
    throw new Error("NEW_RELIC_LICENSE_KEY is required");
  }

  const endpoint = region === "EU"
    ? "https://otlp.eu01.nr-data.net:4318"
    : "https://otlp.nr-data.net:4318";

  const headers = {
    "api-key": licenseKey,
  };

  return {
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    }),
    metricExporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
    }),
  };
}

/**
 * 6. Elastic APM
 * Sign up: https://cloud.elastic.co/registration
 * 14-day free trial
 */
export function createElasticExporter(): ExporterConfig {
  const cloudId = process.env.ELASTIC_CLOUD_ID;
  const secretToken = process.env.ELASTIC_APM_SECRET_TOKEN;
  const serverUrl = process.env.ELASTIC_APM_SERVER_URL;

  if (!serverUrl || !secretToken) {
    throw new Error("ELASTIC_APM_SERVER_URL and ELASTIC_APM_SECRET_TOKEN are required");
  }

  const headers = {
    "Authorization": `Bearer ${secretToken}`,
  };

  return {
    traceExporter: new OTLPTraceExporter({
      url: `${serverUrl}/v1/traces`,
      headers,
    }),
  };
}

/**
 * 7. Self-hosted SigNoz
 * Deploy: https://signoz.io/docs/install/
 */
export function createSelfHostedSigNozExporter(): ExporterConfig {
  const endpoint = process.env.SIGNOZ_ENDPOINT || "http://localhost:4318";

  return {
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    metricExporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
    }),
  };
}

/**
 * Auto-select exporter based on environment variables
 */
export function createAutoExporter(): ExporterConfig {
  // Priority order:
  // 1. Explicit OTEL_EXPORTER_OTLP_ENDPOINT
  // 2. SigNoz Cloud
  // 3. Grafana Cloud
  // 4. Honeycomb
  // 5. New Relic
  // 6. Local Jaeger (default)

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // Custom OTLP endpoint
    return createCustomExporter();
  }

  if (process.env.SIGNOZ_ACCESS_TOKEN) {
    return createSigNozExporter();
  }

  if (process.env.GRAFANA_INSTANCE_ID && process.env.GRAFANA_API_KEY) {
    return createGrafanaCloudExporter();
  }

  if (process.env.HONEYCOMB_API_KEY) {
    return createHoneycombExporter();
  }

  if (process.env.NEW_RELIC_LICENSE_KEY) {
    return createNewRelicExporter();
  }

  // Default to local Jaeger
  return createLocalJaegerExporter();
}

/**
 * Custom OTLP endpoint (for any OTLP-compatible backend)
 */
export function createCustomExporter(): ExporterConfig {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const headers: Record<string, string> = {};

  // Parse OTEL_EXPORTER_OTLP_HEADERS
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    const headerPairs = process.env.OTEL_EXPORTER_OTLP_HEADERS.split(",");
    headerPairs.forEach((pair) => {
      const [key, value] = pair.split("=");
      if (key && value) {
        headers[key.trim()] = value.trim();
      }
    });
  }

  return {
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    }),
    metricExporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
    }),
  };
}
