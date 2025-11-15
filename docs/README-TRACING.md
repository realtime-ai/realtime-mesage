# 追踪功能使用指南

## ⚡ 3 步启用追踪

### 第 1 步: 启动观测后端

```bash
docker-compose -f docker-compose.observability.yml up -d
```

### 第 2 步: 在代码中添加一行

```typescript
import { initTracing } from "./src/tracing/setup";

initTracing(); // ✨ 就这么简单!
```

### 第 3 步: 查看追踪数据

打开浏览器: http://localhost:16686

---

## 📖 详细文档

| 文档 | 内容 |
|------|------|
| [快速开始](./QUICK-START.md) | 3 分钟上手指南 |
| [可观测性概览](./OBSERVABILITY.md) | 方案架构和价值 |
| [追踪指南](./TRACING.md) | 完整的 API 参考和配置 |
| [依赖安装](./TRACING-DEPENDENCIES.md) | NPM 包清单 |

---

## 🎯 核心特性

### 自动追踪
- ✅ Socket.IO 连接和事件
- ✅ Presence 操作 (join/heartbeat/leave)
- ✅ Redis 命令
- ✅ Metadata 操作
- ✅ 跨服务追踪

### 零配置
```typescript
// 开发环境 - 100% 采样,控制台输出
NODE_ENV=development
initTracing();

// 生产环境 - 10% 采样,无控制台输出
NODE_ENV=production
initTracing();
```

### 环境变量优先
```bash
# 所有配置都可以用环境变量覆盖
OTEL_SERVICE_NAME=my-service
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_SAMPLING_RATE=0.5
```

---

## 🚀 使用示例

### 最简示例 (50 行代码)

查看: `backend/examples/simple-traced-server.ts`

```typescript
import { initTracing } from "./src/tracing/setup";
import { createSocketTraceMiddleware } from "./src/tracing/socket-middleware";

// 1. 启用追踪
initTracing();

// 2. 创建 Socket.IO 服务器
const io = new Server(httpServer);

// 3. 添加追踪中间件
createSocketTraceMiddleware(io);

// 4. 照常运行你的服务
// 所有操作都会自动追踪!
```

### 自定义配置

```typescript
initTracing({
  // 仅覆盖需要的参数
  otlpEndpoint: "http://your-collector:4318",
  samplingRate: 0.2, // 20% 采样
});
```

### 手动创建 Spans

```typescript
import { TraceService } from "./src/tracing/trace-service";

const tracer = new TraceService();

await tracer.tracePresenceOperation("join", {
  "presence.room_id": roomId,
}, async (span) => {
  // 你的逻辑
  span.addEvent("custom_event");
  return result;
});
```

---

## 📊 可视化界面

### Jaeger (追踪)
- **地址**: http://localhost:16686
- **用途**: 查看完整请求链路,分析延迟

### Grafana (指标)
- **地址**: http://localhost:3001
- **用户名/密码**: admin/admin
- **用途**: 监控关键指标,设置告警

### Prometheus (查询)
- **地址**: http://localhost:9090
- **用途**: 原始指标查询和探索

---

## 🔧 配置参考

### 智能默认值

| 参数 | 开发环境 | 生产环境 |
|------|---------|---------|
| `serviceName` | "realtime-presence-service" | 同左 |
| `samplingRate` | 1.0 (100%) | 0.1 (10%) |
| `consoleExport` | true | false |
| `otlpEndpoint` | "http://localhost:4318" | 同左 |

### 环境变量

```bash
# 服务标识
OTEL_SERVICE_NAME=my-service

# OTLP Collector 地址
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318

# 采样率 (0.0 - 1.0)
OTEL_SAMPLING_RATE=0.5

# 启用/禁用追踪
OTEL_ENABLED=true
```

---

## 💡 最佳实践

### ✅ 推荐

```typescript
// 1. 最简配置 - 使用所有默认值
initTracing();

// 2. 生产配置 - 仅自定义 endpoint
initTracing({
  otlpEndpoint: "http://prod-collector:4318"
});

// 3. 环境变量配置 - 最灵活
// .env 文件中配置,代码不用改
OTEL_EXPORTER_OTLP_ENDPOINT=...
initTracing();
```

### ❌ 不推荐

```typescript
// 过度配置 - 大多数默认值已经很好
initTracing({
  serviceName: "realtime-presence-service", // 默认值
  version: "1.0.0", // 默认值
  enabled: true, // 默认值
  enableMetrics: true, // 默认值
  metricsExportIntervalMs: 60000, // 默认值
  enableRedisInstrumentation: true, // 默认值
});
```

---

## 🐛 故障排查

### Jaeger 没有数据?

```bash
# 1. 检查 OTLP Collector
curl http://localhost:4318/v1/traces

# 2. 检查环境变量
echo $OTEL_ENABLED  # 应该是 true 或空

# 3. 查看服务器日志
# 应该看到: "OpenTelemetry initialized for realtime-presence-service"
```

### 性能影响太大?

```typescript
// 降低采样率
initTracing({
  samplingRate: 0.1 // 仅追踪 10% 请求
});
```

### 禁用追踪

```bash
# 方法 1: 环境变量
OTEL_ENABLED=false

# 方法 2: 代码
initTracing({ enabled: false });

# 方法 3: 删除 initTracing() 调用
```

---

## 📚 更多资源

- [OpenTelemetry 文档](https://opentelemetry.io/docs/)
- [Jaeger 文档](https://www.jaegertracing.io/docs/)
- [完整示例代码](../backend/examples/)
- [TypeScript 类型定义](../backend/src/tracing/types.ts)

---

## 🎉 总结

**最简单的方式**:
1. `docker-compose -f docker-compose.observability.yml up -d`
2. 代码中添加 `initTracing()`
3. 打开 http://localhost:16686

**就这么简单!** 🚀
