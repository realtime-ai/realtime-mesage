# 追踪功能快速开始 (3 分钟)

## 最简单的方式启用追踪

### 1️⃣ 启动观测后端 (30 秒)

```bash
docker-compose -f docker-compose.observability.yml up -d
```

等待容器启动完成:
- ✅ Jaeger: http://localhost:16686
- ✅ Prometheus: http://localhost:9090
- ✅ Grafana: http://localhost:3001

### 2️⃣ 在代码中启用追踪 (2 行代码)

```typescript
import { initTracing } from "./src/tracing/setup";

// ✨ 就这一行！所有配置都自动完成
initTracing();

// 然后正常启动你的服务器...
```

### 3️⃣ 运行服务器

```bash
# 使用最简示例
npx ts-node backend/examples/simple-traced-server.ts

# 或使用你自己的服务器
npm run dev
```

### 4️⃣ 查看追踪数据

打开浏览器访问:
- **Jaeger UI**: http://localhost:16686
  - Service 选择 "realtime-presence-service"
  - 点击 "Find Traces"

就这么简单! 🎉

## 智能默认配置

`initTracing()` 不需要任何参数,会自动配置:

| 配置项 | 开发环境 | 生产环境 |
|--------|---------|---------|
| **采样率** | 100% | 10% |
| **控制台输出** | ✅ 启用 | ❌ 禁用 |
| **OTLP 端点** | localhost:4318 | localhost:4318 |
| **指标收集** | ✅ 启用 | ✅ 启用 |
| **Redis 追踪** | ✅ 启用 | ✅ 启用 |

## 环境变量覆盖

如果需要自定义,使用环境变量:

```bash
# .env 文件
OTEL_ENABLED=true
OTEL_SERVICE_NAME=my-service
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_SAMPLING_RATE=0.5  # 50% 采样
```

或在代码中覆盖:

```typescript
initTracing({
  otlpEndpoint: "http://your-collector:4318",
  samplingRate: 0.2, // 20% 采样
});
```

## 完整示例

查看 `backend/examples/simple-traced-server.ts` - 只需 50 行代码!

## 下一步

- [详细配置文档](./TRACING.md)
- [可观测性方案概览](./OBSERVABILITY.md)
- [依赖安装指南](./TRACING-DEPENDENCIES.md)

## 常见问题

### Q: 追踪会影响性能吗?
A: 性能开销 < 5%,生产环境建议使用 10% 采样率。

### Q: 需要安装额外的依赖吗?
A: 需要,参考 [依赖安装指南](./TRACING-DEPENDENCIES.md)

### Q: 可以禁用追踪吗?
A: 可以,设置 `OTEL_ENABLED=false` 或 `initTracing({ enabled: false })`

### Q: Jaeger 显示没有数据?
A: 检查:
1. OTLP Collector 是否运行: `curl http://localhost:4318`
2. 环境变量 `OTEL_ENABLED` 是否为 true
3. 查看服务器日志是否有错误

### Q: 想在生产环境使用怎么办?
A: 只需修改环境变量:
```bash
NODE_ENV=production
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-production-collector:4318
```

采样率会自动降低到 10%,控制台输出会自动禁用。
