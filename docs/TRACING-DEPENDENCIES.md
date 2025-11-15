# 追踪功能依赖清单

## NPM 依赖

为了使用完整的追踪功能,需要安装以下依赖包:

### 核心依赖

```bash
npm install --save \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

### 追踪相关

```bash
npm install --save \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-http
```

### 指标相关

```bash
npm install --save \
  @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-metrics-otlp-http
```

### 自动追踪

```bash
npm install --save \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation-ioredis
```

## 完整安装命令

```bash
npm install --save \
  @opentelemetry/api@^1.9.0 \
  @opentelemetry/sdk-node@^0.52.0 \
  @opentelemetry/resources@^1.25.0 \
  @opentelemetry/semantic-conventions@^1.25.0 \
  @opentelemetry/sdk-trace-node@^1.25.0 \
  @opentelemetry/sdk-metrics@^1.25.0 \
  @opentelemetry/exporter-trace-otlp-http@^0.52.0 \
  @opentelemetry/exporter-metrics-otlp-http@^0.52.0 \
  @opentelemetry/auto-instrumentations-node@^0.48.0 \
  @opentelemetry/instrumentation-ioredis@^0.42.0
```

## TypeScript 类型定义

如果使用 TypeScript,类型定义已包含在上述包中,无需额外安装 @types 包。

## 可选依赖

### Console 导出器 (调试用)

如果需要在开发环境输出追踪到控制台:

```bash
npm install --save @opentelemetry/sdk-trace-base
```

### Jaeger 导出器 (直连)

如果不使用 OTLP Collector,可以直接导出到 Jaeger:

```bash
npm install --save @opentelemetry/exporter-jaeger
```

### Prometheus 导出器 (直连)

如果需要直接暴露 Prometheus 指标端点:

```bash
npm install --save @opentelemetry/exporter-prometheus
```

## Docker 依赖

可观测性后端通过 Docker Compose 运行,确保已安装:

- Docker Engine 20.10+
- Docker Compose 2.0+

## 验证安装

```bash
# 检查依赖是否正确安装
npm list @opentelemetry/api
npm list @opentelemetry/sdk-node

# 运行测试
npm test

# 启动示例服务器
npx ts-node backend/examples/traced-server.ts
```

## 故障排查

### 模块未找到错误

如果遇到 `Cannot find module '@opentelemetry/...'` 错误:

```bash
# 清理并重新安装
rm -rf node_modules package-lock.json
npm install
```

### 版本冲突

确保所有 OpenTelemetry 包使用兼容版本:

```bash
# 检查过时的包
npm outdated

# 更新到最新兼容版本
npm update
```

### TypeScript 编译错误

如果遇到类型错误,确保 tsconfig.json 包含:

```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```
