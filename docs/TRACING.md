# Distributed Tracing and Observability Guide

本文档介绍如何为 Realtime Presence Service 启用和使用分布式追踪(Distributed Tracing)和可观测性(Observability)功能。

## 目录

- [概述](#概述)
- [快速开始](#快速开始)
- [架构设计](#架构设计)
- [配置选项](#配置选项)
- [使用指南](#使用指南)
- [可观测性后端](#可观测性后端)
- [最佳实践](#最佳实践)
- [故障排查](#故障排查)

## 概述

### 什么是分布式追踪?

分布式追踪是一种监控和分析分布式系统中请求流的技术。它可以帮助你:

- **追踪请求路径**: 从客户端到服务器,再到 Redis,完整追踪每个操作的生命周期
- **性能分析**: 识别性能瓶颈,了解每个操作的耗时分布
- **错误诊断**: 快速定位错误发生的位置和原因
- **依赖关系**: 理解服务之间的调用关系和依赖

### 技术栈

本项目使用 **OpenTelemetry** (OTel) 作为可观测性框架:

- **Traces**: 追踪请求流和操作链路
- **Metrics**: 收集性能指标和业务指标
- **Logs**: 结构化日志(未来支持)

支持的后端:
- **Jaeger**: 分布式追踪可视化
- **Prometheus**: 指标收集和存储
- **Grafana**: 指标可视化和仪表板

## 快速开始

### 1. 安装依赖

```bash
npm install --save \
  @opentelemetry/sdk-node \
  @opentelemetry/api \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation-ioredis
```

### 2. 启动可观测性后端

使用 Docker Compose 快速启动 Jaeger、Prometheus 和 Grafana:

```bash
docker-compose -f docker-compose.observability.yml up -d
```

这将启动:
- **Jaeger UI**: http://localhost:16686
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3001 (用户名/密码: admin/admin)
- **OTLP Collector**: http://localhost:4318

### 3. 启用追踪

在应用程序启动时初始化追踪:

```typescript
import { initTracing } from "./src/tracing/setup";

// 在所有其他导入之前初始化追踪
initTracing({
  serviceName: "realtime-presence-service",
  version: "1.0.0",
  environment: "production",
  enabled: true,
  samplingRate: 1.0, // 100% 采样
  otlpEndpoint: "http://localhost:4318",
  enableMetrics: true,
  enableRedisInstrumentation: true,
});
```

### 4. 运行示例服务器

```bash
# 使用带追踪的示例服务器
npm run build
node dist/examples/traced-server.js

# 或使用 ts-node 开发
npx ts-node backend/examples/traced-server.ts
```

### 5. 查看追踪数据

1. 打开 Jaeger UI: http://localhost:16686
2. 在 "Service" 下拉框中选择 "realtime-presence-service"
3. 点击 "Find Traces" 查看所有追踪
4. 点击单个追踪查看详细的调用链路

## 架构设计

### 追踪流程

```
┌─────────────┐
│   Client    │
│  (Browser)  │
└──────┬──────┘
       │ Socket.IO Event
       ▼
┌─────────────────────────────────┐
│  Socket.IO Trace Middleware     │
│  - 创建 connection span         │
│  - 提取 trace context           │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  Presence Handlers              │
│  - join/heartbeat/leave spans   │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  PresenceService                │
│  - 业务逻辑 spans               │
│  - 添加业务属性                 │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  Redis Instrumentation          │
│  - Redis 命令 spans             │
│  - 延迟监控                     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  OTLP Exporter                  │
│  - 发送到 Collector/Jaeger      │
└─────────────────────────────────┘
```

### 关键组件

1. **TraceService** (`src/tracing/trace-service.ts`)
   - 创建和管理 spans
   - 提供便捷的追踪 API

2. **Socket Middleware** (`src/tracing/socket-middleware.ts`)
   - 自动追踪 Socket.IO 连接和事件
   - 传播 trace context

3. **Redis Instrumentation** (`src/tracing/redis-instrumentation.ts`)
   - 追踪 Redis 命令
   - 监控 pub/sub 操作

4. **Metrics** (`src/tracing/metrics.ts`)
   - 收集业务指标
   - 性能指标

## 配置选项

### TracingConfig

```typescript
interface TracingConfig {
  // 服务名称
  serviceName?: string; // 默认: "realtime-presence-service"

  // 服务版本
  version?: string;

  // 环境 (development, staging, production)
  environment?: string;

  // 是否启用追踪
  enabled?: boolean; // 默认: true

  // 采样率 (0.0 - 1.0)
  samplingRate?: number; // 默认: 1.0 (100%)

  // OTLP 导出端点
  otlpEndpoint?: string; // 默认: "http://localhost:4318"

  // 是否输出到控制台(调试用)
  consoleExport?: boolean; // 默认: false

  // 是否启用指标收集
  enableMetrics?: boolean; // 默认: true

  // 指标导出间隔(毫秒)
  metricsExportIntervalMs?: number; // 默认: 60000

  // 是否启用 Redis 自动追踪
  enableRedisInstrumentation?: boolean; // 默认: true
}
```

### 环境变量

```bash
# OpenTelemetry 配置
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=realtime-presence-service
OTEL_RESOURCE_ATTRIBUTES=service.version=1.0.0,deployment.environment=production

# Node.js 环境
NODE_ENV=production
```

## 使用指南

### 1. 追踪 Presence 操作

使用 `InstrumentedPresenceService`:

```typescript
import { InstrumentedPresenceService } from "./src/tracing/instrumented-service";

const service = new InstrumentedPresenceService(redis, {
  ttlMs: 30_000,
  reaperIntervalMs: 3_000,
  reaperLookbackMs: 60_000,
});

// 所有操作自动追踪
await service.join({ roomId, userId, connId, state });
```

### 2. 手动创建 Spans

```typescript
import { TraceService } from "./src/tracing/trace-service";

const traceService = new TraceService("my-service");

// 创建并执行 span
await traceService.tracePresenceOperation(
  "join",
  {
    "presence.room_id": roomId,
    "presence.user_id": userId,
  },
  async (span) => {
    // 你的业务逻辑
    span.addEvent("user_authenticated");
    span.setAttribute("custom.attribute", "value");

    return result;
  }
);
```

### 3. 添加自定义属性

```typescript
// 在 span 中添加属性
traceService.setAttributes({
  "user.subscription_tier": "premium",
  "feature.flag.enabled": true,
});

// 添加事件
traceService.addEvent("cache_miss", {
  cache_key: "user:123",
});
```

### 4. 跨 Pub/Sub 追踪

```typescript
// 发布事件时提取 trace context
const traceContext = traceService.extractTraceContext();
await redis.publish(channel, JSON.stringify({
  ...payload,
  _trace: traceContext, // 传播 trace context
}));

// 订阅端继续追踪
subscriber.on("message", (channel, message) => {
  const data = JSON.parse(message);

  if (data._trace) {
    const span = traceService.continueTrace(
      data._trace,
      `pubsub.${channel}`
    );

    // 在 span 上下文中处理消息
    traceService.withSpan(span, async () => {
      await handleMessage(data);
    });
  }
});
```

### 5. 收集指标

```typescript
import { createMetrics } from "./src/tracing/metrics";

const metrics = createMetrics(redis);

// 记录操作
metrics.recordOperation("join", { room_id: roomId });

// 记录延迟
metrics.recordOperationDuration("heartbeat", 15); // 15ms

// 测量并记录
await metrics.measureOperation("join", async () => {
  return service.join(options);
});
```

## 可观测性后端

### Jaeger

**访问**: http://localhost:16686

**功能**:
- 查看完整的请求追踪链路
- 分析延迟分布
- 识别性能瓶颈
- 错误追踪

**使用技巧**:
1. 使用 "Tags" 过滤特定的 room_id 或 user_id
2. 使用 "Duration" 过滤慢请求
3. 点击 span 查看详细的时间线和属性

### Prometheus

**访问**: http://localhost:9090

**查询示例**:

```promql
# 每秒操作数
rate(presence_operation_total[1m])

# P95 操作延迟
histogram_quantile(0.95, rate(presence_operation_duration_bucket[5m]))

# 错误率
rate(presence_error_total[1m]) / rate(presence_operation_total[1m])

# 活跃房间数
presence_rooms_active
```

### Grafana

**访问**: http://localhost:3001

**预配置的仪表板**:
- Realtime Presence Service Dashboard
  - 活跃房间数
  - 操作吞吐量
  - 延迟分布
  - 错误率
  - Redis 性能

**创建告警**:
1. 在 Grafana 中创建 Alert Rules
2. 设置阈值 (如 p95 延迟 > 100ms)
3. 配置通知渠道 (Slack, Email, PagerDuty)

## 最佳实践

### 1. 采样策略

- **开发环境**: 100% 采样 (`samplingRate: 1.0`)
- **生产环境**: 根据流量调整 (如 10% 采样 `samplingRate: 0.1`)
- **高流量**: 使用 Tail-based Sampling (仅保留慢请求和错误)

### 2. Span 命名

遵循 OpenTelemetry 语义约定:
- 使用小写和下划线: `presence.join`
- 包含操作类型: `redis.hget`, `socket.event`
- 保持简洁且描述性强

### 3. 属性命名

使用语义约定前缀:
- `presence.*`: Presence 相关属性
- `metadata.*`: Metadata 相关属性
- `redis.*`: Redis 相关属性
- `socket.*`: Socket.IO 相关属性
- `db.*`: 数据库相关属性

### 4. 敏感数据

**不要**在 span 属性中包含:
- 密码和密钥
- 个人身份信息 (PII)
- 完整的用户状态对象

**可以**包含:
- 用户 ID (脱敏后的)
- 房间 ID
- 操作类型
- 错误码

### 5. 性能优化

- 使用批量导出减少网络开销
- 在高流量场景下降低采样率
- 避免在热路径中创建过多 spans
- 使用 `memory_limiter` 防止内存泄漏

## 故障排查

### 追踪数据未显示

1. **检查 OTLP 端点连接**:
   ```bash
   curl http://localhost:4318/v1/traces
   ```

2. **启用调试日志**:
   ```typescript
   initTracing({
     consoleExport: true,
   });
   ```

3. **检查 Jaeger 容器**:
   ```bash
   docker logs jaeger
   ```

### 性能影响

OpenTelemetry 的性能开销通常 < 5%:

- **减少采样率**: `samplingRate: 0.1`
- **使用批量处理**: 默认已启用
- **禁用自动追踪**: 仅手动创建关键 spans

### 指标缺失

1. **检查指标导出器**:
   ```bash
   curl http://localhost:8889/metrics
   ```

2. **验证 Prometheus 配置**:
   ```bash
   docker exec -it prometheus cat /etc/prometheus/prometheus.yml
   ```

### 常见问题

**Q: 追踪数据太多,存储成本高?**
A: 降低采样率,使用 tail-based sampling,或配置数据保留策略。

**Q: 如何在多个服务间传播 trace context?**
A: 使用 W3C Trace Context headers,或在消息体中传递 trace ID。

**Q: 生产环境应该使用什么采样率?**
A: 建议从 10% 开始,根据流量和成本调整。重要的是保留所有错误追踪。

## 相关资源

- [OpenTelemetry 官方文档](https://opentelemetry.io/docs/)
- [Jaeger 文档](https://www.jaegertracing.io/docs/)
- [Prometheus 查询语言](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Grafana 仪表板](https://grafana.com/docs/grafana/latest/dashboards/)

## 下一步

- 探索自定义 Grafana 仪表板
- 设置告警规则
- 集成到 CI/CD 流程
- 添加日志关联 (Logs <> Traces)
