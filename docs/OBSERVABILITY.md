# 可观测性方案概览

## 为什么需要可观测性?

在分布式实时系统中,可观测性至关重要:

### 🎯 核心价值

1. **性能监控**
   - 实时追踪系统性能指标
   - 识别和优化性能瓶颈
   - 监控资源使用情况

2. **故障诊断**
   - 快速定位问题根源
   - 追踪错误传播路径
   - 减少 MTTR (Mean Time To Repair)

3. **业务洞察**
   - 了解用户行为模式
   - 监控关键业务指标
   - 支持数据驱动决策

4. **容量规划**
   - 预测资源需求
   - 优化基础设施成本
   - 支持弹性扩展

## 方案架构

### 三大支柱

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Traces    │     │   Metrics   │     │    Logs     │
│  分布式追踪  │     │   性能指标   │     │  结构化日志  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                          │
                ┌─────────▼──────────┐
                │  OpenTelemetry     │
                │  统一可观测性框架   │
                └─────────┬──────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
┌──────▼──────┐   ┌───────▼────────┐  ┌─────▼──────┐
│   Jaeger    │   │   Prometheus   │  │   Loki     │
│  追踪后端    │   │   指标存储     │  │  日志聚合   │
└──────┬──────┘   └───────┬────────┘  └─────┬──────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                  ┌───────▼────────┐
                  │    Grafana     │
                  │   可视化平台    │
                  └────────────────┘
```

### 技术选型

| 组件 | 技术 | 用途 |
|------|------|------|
| **追踪框架** | OpenTelemetry | 统一的可观测性 API 和 SDK |
| **追踪后端** | Jaeger | 分布式追踪存储和查询 |
| **指标收集** | Prometheus | 时序数据库和告警 |
| **可视化** | Grafana | 仪表板和监控面板 |
| **采集器** | OTLP Collector | 遥测数据路由和处理 |

## 追踪的内容

### 1. Socket.IO 连接追踪

- 连接建立和断开
- 传输协议 (WebSocket, polling)
- 客户端地址和元数据

### 2. Presence 操作追踪

**Join 操作**:
- 房间加入时间
- 初始状态设置
- 快照大小

**Heartbeat 操作**:
- 心跳频率
- 状态更新
- Epoch 变化

**Leave 操作**:
- 离开原因
- 清理操作
- 剩余成员数

### 3. Redis 操作追踪

- 命令类型和参数
- 执行延迟
- Pipeline 批处理
- Pub/Sub 消息

### 4. Metadata 操作追踪

- Set/Update/Remove 操作
- 版本冲突检测
- 锁获取和释放
- 事务重试

### 5. 后台任务追踪

- Reaper 清理周期
- 清理的连接数
- 房间状态变化

## 收集的指标

### 业务指标

```typescript
// 活跃连接数
presence.connections.active

// 活跃房间数
presence.rooms.active

// 操作总数 (按类型)
presence.operation.total{operation="join|heartbeat|leave"}

// 事件发布总数
presence.event.total{event_type="join|leave|update"}
```

### 性能指标

```typescript
// 操作延迟分布 (直方图)
presence.operation.duration{operation="join|heartbeat|leave"}

// Redis 命令延迟
redis.command.duration{command="hget|hset|sadd|..."}

// 心跳处理延迟
presence.heartbeat.latency
```

### 系统指标

```typescript
// 错误计数
presence.error.total{operation="...", error_type="..."}

// Node.js 进程指标 (自动采集)
nodejs.heap.size.total
nodejs.heap.size.used
nodejs.eventloop.lag
```

## 关键 Span 属性

### Presence Spans

```typescript
{
  "presence.operation": "join|heartbeat|leave|reap",
  "presence.room_id": "room-123",
  "presence.user_id": "user-456",
  "presence.conn_id": "socket-789",
  "presence.epoch": 1234567890,
  "presence.state_changed": true,
  "presence.snapshot_size": 5
}
```

### Redis Spans

```typescript
{
  "db.system": "redis",
  "redis.command": "HGET",
  "redis.key": "prs:conn:socket-123",
  "redis.latency_ms": 2.5,
  "redis.pipeline": "join_operation",
  "redis.command_count": 8
}
```

### Socket.IO Spans

```typescript
{
  "socket.event": "presence:join",
  "socket.connection_id": "socket-123",
  "socket.transport": "websocket",
  "client.address": "192.168.1.100"
}
```

## 使用场景

### 1. 性能优化

**场景**: 发现 join 操作较慢

**步骤**:
1. 在 Jaeger 中筛选 `operation=join` 且 `duration > 100ms` 的追踪
2. 分析 span timeline,识别慢的子操作
3. 查看 Redis spans,检查是否有慢查询
4. 在 Grafana 中查看 Redis 命令延迟趋势
5. 优化: 使用 pipeline 批处理,或启用 Lua 脚本

### 2. 错误诊断

**场景**: 用户报告无法加入房间

**步骤**:
1. 在 Jaeger 中搜索 user_id 或 room_id
2. 查看完整的请求链路
3. 检查哪个 span 标记为错误 (红色)
4. 查看 span 的 exception 事件和 error 属性
5. 关联 Prometheus 指标,查看错误率趋势

### 3. 容量规划

**场景**: 预测双十一流量高峰所需资源

**步骤**:
1. 在 Grafana 中查看历史指标趋势
2. 分析 `presence.rooms.active` 增长率
3. 计算 Redis 操作 QPS
4. 使用负载测试验证
5. 根据预测扩容 Redis 集群和应用实例

### 4. SLA 监控

**场景**: 确保 99% 的心跳延迟 < 50ms

**步骤**:
1. 在 Prometheus 中查询 p99 延迟:
   ```promql
   histogram_quantile(0.99, rate(presence_heartbeat_latency_bucket[5m]))
   ```
2. 在 Grafana 中创建仪表板
3. 设置告警规则: p99 > 50ms 持续 5 分钟
4. 配置 PagerDuty/Slack 通知

## 快速开始

### 1. 启动观测后端

```bash
# 启动 Jaeger + Prometheus + Grafana
docker-compose -f docker-compose.observability.yml up -d

# 验证服务
curl http://localhost:16686  # Jaeger
curl http://localhost:9090   # Prometheus
curl http://localhost:3001   # Grafana
```

### 2. 启用追踪

```typescript
// backend/src/server.ts
import { initTracing } from "./tracing/setup";

// 在应用启动时初始化
initTracing({
  serviceName: "realtime-presence-service",
  environment: "production",
  otlpEndpoint: "http://localhost:4318",
  enableMetrics: true,
});
```

### 3. 运行应用

```bash
# 开发模式
npm run dev

# 生产模式
npm run build
npm start
```

### 4. 查看数据

- **Jaeger**: http://localhost:16686
  - 搜索 service: `realtime-presence-service`
  - 查看 traces

- **Grafana**: http://localhost:3001
  - 用户名/密码: admin/admin
  - 打开 "Realtime Presence Service" 仪表板

## 进阶主题

### 自定义追踪

创建自定义 spans:

```typescript
import { TraceService } from "./tracing/trace-service";

const tracer = new TraceService();

await tracer.tracePresenceOperation("join", {
  "presence.room_id": roomId,
}, async (span) => {
  // 你的逻辑
  span.addEvent("custom_event", { key: "value" });
  return result;
});
```

### 跨服务追踪

在 pub/sub 中传播 trace context:

```typescript
// 发布端
const traceContext = tracer.extractTraceContext();
await redis.publish(channel, JSON.stringify({
  data: payload,
  _trace: traceContext,
}));

// 订阅端
subscriber.on("message", (ch, msg) => {
  const { data, _trace } = JSON.parse(msg);
  const span = tracer.continueTrace(_trace, "handle_event");
  // 处理消息
});
```

### 自定义指标

```typescript
import { createMetrics } from "./tracing/metrics";

const metrics = createMetrics(redis);

// 记录自定义指标
metrics.recordOperation("custom_operation", {
  custom_label: "value",
});
```

## 最佳实践

### ✅ 推荐

- 在生产环境使用合理的采样率 (10-20%)
- 为关键操作添加详细的 span 属性
- 使用语义化的 span 和属性命名
- 设置告警阈值和通知
- 定期审查和优化仪表板

### ❌ 避免

- 不要在 span 中记录敏感信息 (密码、token)
- 避免过度追踪 (每个函数都创建 span)
- 不要在热路径中执行同步操作
- 避免将完整的对象序列化到属性中

## 相关文档

- [详细追踪指南](./TRACING.md)
- [OpenTelemetry 文档](https://opentelemetry.io/docs/)
- [Jaeger 文档](https://www.jaegertracing.io/docs/)
- [Prometheus 查询](https://prometheus.io/docs/prometheus/latest/querying/basics/)

## 支持和反馈

如有问题或建议,请:
- 查看 [故障排查](./TRACING.md#故障排查) 章节
- 提交 GitHub Issue
- 参与社区讨论
