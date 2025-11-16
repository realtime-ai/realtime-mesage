# Tracing 后端服务对比指南

本文档列出了可用于测试和生产的 tracing 后端服务，包括开源自托管和商业化 SaaS 方案。

## 🆓 免费可用的 Tracing 服务

### 1. SigNoz (推荐 - 开源且易用)

**优势**:
- ✅ 完全开源，可自托管
- ✅ 提供免费的云托管版本
- ✅ 内置 Traces、Metrics、Logs 三合一
- ✅ 界面现代化，比 Jaeger 更好用
- ✅ 支持 OpenTelemetry 原生

**部署方式**:

```yaml
# docker-compose.signoz.yml
version: "3.9"

services:
  # SigNoz 官方 Docker Compose
  # 访问: https://signoz.io/docs/install/docker/
```

**云托管版本**: https://signoz.io/teams/
- 免费额度: 1GB/月数据摄入
- 无需信用卡

**配置**:
```typescript
initTracing({
  otlpEndpoint: "https://ingest.{region}.signoz.cloud:443",
  // 使用你的 SigNoz ingestion key
});
```

---

### 2. Grafana Cloud (推荐 - 慷慨的免费层)

**优势**:
- ✅ Grafana Labs 官方服务
- ✅ 免费额度非常慷慨
- ✅ Grafana Tempo (traces) + Prometheus + Loki 一体化
- ✅ 14 天数据保留
- ✅ 无需信用卡注册

**免费额度**:
- Traces: 50GB/月
- Metrics: 10k series
- Logs: 50GB/月

**注册**: https://grafana.com/auth/sign-up/create-user

**配置**:
```typescript
initTracing({
  otlpEndpoint: "https://otlp-gateway-{region}.grafana.net/otlp",
  // Headers 需要包含 API key
});
```

**详细配置**:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/traces",
  headers: {
    "Authorization": `Basic ${Buffer.from(
      `${GRAFANA_INSTANCE_ID}:${GRAFANA_API_KEY}`
    ).toString("base64")}`,
  },
});
```

---

### 3. Honeycomb (优秀的免费层)

**优势**:
- ✅ 业界领先的可观测性平台
- ✅ 强大的查询和分析功能
- ✅ 免费层非常实用

**免费额度**:
- 20M events/月
- 60 天数据保留
- 完整功能访问

**注册**: https://ui.honeycomb.io/signup

**配置**:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "https://api.honeycomb.io/v1/traces",
  headers: {
    "x-honeycomb-team": process.env.HONEYCOMB_API_KEY,
  },
});
```

---

### 4. New Relic (功能强大)

**优势**:
- ✅ 企业级 APM 平台
- ✅ 永久免费层
- ✅ 100GB/月数据摄入
- ✅ 1 个免费完整用户

**注册**: https://newrelic.com/signup

**配置**:
```typescript
initTracing({
  otlpEndpoint: "https://otlp.nr-data.net:4318",
  // 需要在 headers 中设置 API key
});
```

**详细配置**:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "https://otlp.nr-data.net:4318/v1/traces",
  headers: {
    "api-key": process.env.NEW_RELIC_LICENSE_KEY,
  },
});
```

---

### 5. Jaeger + Jaeger Cloud (完全免费自托管)

**优势**:
- ✅ CNCF 毕业项目
- ✅ 完全开源
- ✅ 我们已经在 docker-compose 中配置好了

**本地部署**:
```bash
docker-compose -f docker-compose.observability.yml up -d
```

**访问**: http://localhost:16686

**云端部署**（免费）:
- Railway.app
- Render.com
- Fly.io

---

### 6. Elastic APM (Elastic Cloud)

**优势**:
- ✅ Elastic Stack 一体化
- ✅ 14 天免费试用
- ✅ 强大的搜索和分析

**注册**: https://cloud.elastic.co/registration

**配置**:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "https://{deployment-id}.apm.{region}.aws.cloud.es.io:443",
  headers: {
    "Authorization": `Bearer ${ELASTIC_APM_SECRET_TOKEN}`,
  },
});
```

---

### 7. Uptrace (开源 + 云托管)

**优势**:
- ✅ 开源
- ✅ 提供云托管版本
- ✅ 支持 OpenTelemetry
- ✅ PostgreSQL 存储

**云托管**: https://uptrace.dev/

**自托管**:
```bash
git clone https://github.com/uptrace/uptrace.git
cd uptrace
docker-compose up -d
```

---

## 📊 服务对比表

| 服务 | 免费额度 | 数据保留 | 需要信用卡 | 易用性 | 推荐度 |
|------|---------|---------|-----------|--------|--------|
| **SigNoz** | 1GB/月 | 15 天 | ❌ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Grafana Cloud** | 50GB/月 | 14 天 | ❌ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Honeycomb** | 20M events/月 | 60 天 | ❌ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **New Relic** | 100GB/月 | 8 天 | ❌ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Jaeger (本地)** | 无限制 | 取决于存储 | ❌ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Elastic APM** | 14 天试用 | 无限 | ✅ | ⭐⭐⭐ | ⭐⭐⭐ |
| **Uptrace** | 自托管无限 | 自定义 | ❌ | ⭐⭐⭐ | ⭐⭐⭐ |

---

## 🎯 推荐方案

### 快速测试和开发
```
推荐: Jaeger (本地 Docker)
原因:
- 已经配置好了
- 无需注册
- 运行简单
- 完全免费
```

### 个人项目/小团队
```
推荐: SigNoz Cloud 或 Grafana Cloud
原因:
- 免费额度足够
- 无需维护基础设施
- 功能强大
- 数据保留时间长
```

### 中型项目
```
推荐: Honeycomb 或 New Relic
原因:
- 更高的免费额度
- 企业级功能
- 更好的分析能力
- 技术支持
```

### 生产环境/大型项目
```
推荐: 自托管 Jaeger/SigNoz + 付费备份
原因:
- 数据隐私
- 可控成本
- 无限制扩展
- 混合云支持
```

---

## 🚀 快速开始指南

### 方案 1: 使用 SigNoz Cloud (推荐新手)

1. **注册账号**: https://signoz.io/teams/
2. **获取配置**:
   - Ingestion endpoint: `https://ingest.{region}.signoz.cloud:443`
   - Ingestion key: 在控制台获取

3. **配置代码**:
```typescript
// .env
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us.signoz.cloud:443
OTEL_EXPORTER_OTLP_HEADERS="signoz-access-token=your-ingestion-key"

// 代码
initTracing(); // 自动读取环境变量
```

### 方案 2: 使用 Grafana Cloud

1. **注册**: https://grafana.com/auth/sign-up/create-user
2. **创建 Stack**: 在 Grafana Cloud 控制台创建
3. **获取配置**:
   - 进入 "Configurations" > "Data Sources" > "Tempo"
   - 复制 OTLP endpoint 和凭据

4. **配置代码**:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

const exporter = new OTLPTraceExporter({
  url: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/traces",
  headers: {
    "Authorization": `Basic ${Buffer.from(
      `${process.env.GRAFANA_INSTANCE_ID}:${process.env.GRAFANA_API_KEY}`
    ).toString("base64")}`,
  },
});
```

### 方案 3: 使用 Honeycomb

1. **注册**: https://ui.honeycomb.io/signup
2. **创建 API Key**: Settings > API Keys
3. **配置代码**:

```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "https://api.honeycomb.io/v1/traces",
  headers: {
    "x-honeycomb-team": process.env.HONEYCOMB_API_KEY,
  },
});
```

---

## 💡 使用建议

### 开发/测试阶段
```bash
# 使用本地 Jaeger (最简单)
docker-compose -f docker-compose.observability.yml up -d
initTracing(); // 默认连接 localhost:4318
```

### 准备上线
```bash
# 注册 SigNoz 或 Grafana Cloud
# 获取免费账号
# 更新环境变量
OTEL_EXPORTER_OTLP_ENDPOINT=https://...
initTracing(); // 自动连接云服务
```

### 生产环境
```bash
# 评估流量和成本
# 选择合适的付费方案
# 或自托管 SigNoz/Jaeger
```

---

## 🔒 安全注意事项

1. **不要在代码中硬编码 API Key**:
   ```typescript
   // ❌ 错误
   headers: { "x-api-key": "abc123..." }

   // ✅ 正确
   headers: { "x-api-key": process.env.API_KEY }
   ```

2. **使用环境变量**:
   ```bash
   # .env (不要提交到 git)
   OTEL_EXPORTER_OTLP_ENDPOINT=...
   OTEL_EXPORTER_OTLP_HEADERS="authorization=..."
   ```

3. **限制采样率**:
   ```typescript
   // 生产环境降低采样率节省成本
   initTracing({
     samplingRate: 0.1 // 10% 采样
   });
   ```

---

## 📈 成本估算

### SigNoz Cloud
- 免费: 1GB/月
- 小型项目 (~100 req/s): $29/月
- 中型项目 (~1000 req/s): $199/月

### Grafana Cloud
- 免费: 50GB/月
- 超出后: $0.50/GB

### Honeycomb
- 免费: 20M events/月
- Pro: $0.0013/event

### 自托管成本
- 服务器: $10-50/月 (VPS)
- 存储: $5-20/月
- 维护时间: ~5h/月

---

## 🎉 总结

**立即可用的免费方案**:

1. **本地开发**: Jaeger (Docker)
2. **云端测试**: SigNoz Cloud 或 Grafana Cloud
3. **深度分析**: Honeycomb (免费层)

所有方案都兼容 OpenTelemetry，切换很简单！
