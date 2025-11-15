# 性能优化特性

本文档介绍 Realtime Message 服务的短期性能优化特性，包括心跳批处理、Lua 脚本优化和事务性 Metadata 操作。

## 概述

为了提升高并发场景下的性能，我们实施了三项关键优化：

1. **心跳批处理（Heartbeat Batching）** - 将短时间内的多个心跳请求合并为一次 Redis Pipeline 操作
2. **Lua 脚本优化（Lua Heartbeat）** - 将心跳操作原子化，减少网络往返次数
3. **事务性 Metadata（Transactional Metadata）** - 使用 Redis WATCH/MULTI 保证原子性

---

## 1. 心跳批处理（Heartbeat Batching）

### 原理

传统方式下，每个心跳请求需要 6+ 次 Redis 操作（HGET, HSET, PEXPIRE, ZADD, PUBLISH 等），在高并发场景下会成为性能瓶颈。

心跳批处理器将短时间窗口（默认 50ms）内的多个心跳请求收集起来，使用 Redis Pipeline 批量处理，显著减少网络往返次数（RTT）。

### 性能提升

- **吞吐量提升**：50-70%
- **延迟降低**：P99 延迟降低 30-40%
- **适用场景**：100+ 并发连接，频繁心跳（< 5秒间隔）

### 启用方式

```typescript
import { initPresence } from '@YOUR_SCOPE/realtime-mesage';

const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableHeartbeatBatching: true,
    heartbeatBatchWindowMs: 50,    // 批处理窗口（毫秒）
    heartbeatMaxBatchSize: 100     // 最大批次大小
  }
});
```

### 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableHeartbeatBatching` | boolean | false | 是否启用心跳批处理 |
| `heartbeatBatchWindowMs` | number | 50 | 批处理窗口时间（毫秒），在此时间内收集的心跳会被批量处理 |
| `heartbeatMaxBatchSize` | number | 100 | 最大批次大小，达到此数量立即触发批处理 |

### 工作原理

```
客户端 1 -> 心跳请求 ─┐
客户端 2 -> 心跳请求 ─┤
客户端 3 -> 心跳请求 ─┼─> 批处理器（50ms 窗口）─> Redis Pipeline ─> 批量响应
客户端 4 -> 心跳请求 ─┤
客户端 5 -> 心跳请求 ─┘
```

### 注意事项

- 批处理会引入最多 `heartbeatBatchWindowMs` 的延迟
- 适合心跳间隔 > 批处理窗口的场景（如心跳间隔 5秒，批处理窗口 50ms）
- 不影响 Epoch Fencing 机制的正确性

---

## 2. Lua 脚本优化（Lua Heartbeat）

### 原理

将心跳操作的多个 Redis 命令合并为一个 Lua 脚本，在 Redis 服务端原子执行，从多次网络往返减少到 1 次。

### 性能提升

- **延迟降低**：单次心跳延迟降低 60-80%
- **吞吐量提升**：30-50%
- **适用场景**：低延迟要求（< 10ms），中等并发（50-500 连接）

### 启用方式

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableLuaHeartbeat: true
  }
});
```

### 工作原理

**传统方式（多次往返）：**
```
客户端 -> HGETALL prs:conn:123      (RTT 1)
       <- 返回连接详情
       -> HSET + PEXPIRE + ZADD     (RTT 2)
       <- OK
       -> HGET epoch                (RTT 3)
       <- 返回 epoch
```

**Lua 脚本方式（单次往返）：**
```
客户端 -> EVALSHA <sha> <keys> <args>  (RTT 1)
       <- { ok: 1, changed: 0, epoch: 12345 }
```

### Lua 脚本内容

脚本包含以下操作：
1. 读取连接详情
2. Epoch fencing 检查
3. 更新 last_seen_ms 和 TTL
4. 可选：更新状态（patchState）
5. 更新 last_seen ZSet
6. 可选：更新 epoch 和 conn_meta

### 注意事项

- Lua 脚本在 Redis 服务端执行，占用 Redis CPU
- 脚本会在服务启动时自动加载到 Redis（`SCRIPT LOAD`）
- 如果 Redis 重启，脚本会自动重新加载
- 与心跳批处理互斥（Lua 优先级更高）

---

## 3. 事务性 Metadata（Transactional Metadata）

### 原理

当前 Metadata 的 CAS（Compare-And-Swap）检查在应用层实现，存在 TOCTOU（Time-Of-Check-Time-Of-Use）竞态条件。

使用 Redis WATCH/MULTI/EXEC 机制，将检查和更新操作原子化，避免并发冲突。

### 性能提升

- **并发安全性**：消除应用层竞态条件
- **冲突重试**：自动重试机制，减少客户端重试逻辑
- **适用场景**：高并发 Metadata 更新（多个客户端同时修改）

### 启用方式

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableTransactionalMetadata: true,
    metadataMaxRetries: 5  // 冲突时最大重试次数
  }
});
```

### 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableTransactionalMetadata` | boolean | false | 是否启用事务性 Metadata |
| `metadataMaxRetries` | number | 5 | WATCH 冲突时的最大重试次数 |

### 工作原理

**传统方式（应用层 CAS）：**
```typescript
// 1. 读取当前状态
const state = await redis.hgetall(key);

// 2. 检查版本（TOCTOU 竞态窗口）
if (state.majorRevision !== expectedRevision) {
  throw new ConflictError();
}

// 3. 更新（可能被其他客户端抢先）
await redis.hset(key, newState);
```

**事务性方式（Redis WATCH/MULTI）：**
```typescript
// 1. WATCH key
await redis.watch(key);

// 2. 读取并检查
const state = await redis.hgetall(key);
if (state.majorRevision !== expectedRevision) {
  await redis.unwatch();
  throw new ConflictError();
}

// 3. 原子更新
const result = await redis.multi()
  .hset(key, newState)
  .exec();

// 4. 检查事务结果
if (result === null) {
  // 冲突，自动重试
  return retry();
}
```

### 注意事项

- WATCH 机制是乐观锁，冲突时会自动重试
- 高冲突场景下可能增加延迟（重试开销）
- 重试次数可通过 `metadataMaxRetries` 配置

---

## 优化特性对比

| 特性 | 吞吐量提升 | 延迟降低 | 适用场景 | 副作用 |
|------|-----------|---------|---------|--------|
| 心跳批处理 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | 高并发（100+ 连接） | 增加最多 50ms 延迟 |
| Lua 脚本 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 低延迟要求（< 10ms） | 占用 Redis CPU |
| 事务性 Metadata | ⭐⭐ | ⭐⭐ | 高并发 Metadata 更新 | 冲突时重试开销 |

---

## 组合使用建议

### 场景 1：高并发、低延迟要求

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableLuaHeartbeat: true,              // 优先使用 Lua 脚本
    enableTransactionalMetadata: true      // Metadata 事务保护
  }
});
```

### 场景 2：超高并发、可容忍延迟

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableHeartbeatBatching: true,         // 批处理提升吞吐
    heartbeatBatchWindowMs: 100,           // 更大的批处理窗口
    heartbeatMaxBatchSize: 200,
    enableTransactionalMetadata: true
  }
});
```

### 场景 3：中等并发、均衡配置

```typescript
const presence = await initPresence({
  io,
  redis,
  optimizations: {
    enableLuaHeartbeat: true,              // Lua 脚本降低延迟
    enableTransactionalMetadata: true,     // Metadata 事务保护
    metadataMaxRetries: 3                  // 适度重试
  }
});
```

---

## 性能基准测试

### 测试环境

- **Redis**: 单实例，4 核 8GB
- **服务器**: Node.js 18，4 核 8GB
- **客户端**: 100 个并发连接，5 秒心跳间隔
- **测试时长**: 5 分钟

### 心跳性能对比

| 配置 | 吞吐量（req/s） | P50 延迟（ms） | P99 延迟（ms） | CPU 使用率 |
|------|----------------|---------------|---------------|-----------|
| 基线（无优化） | 180 | 12 | 45 | 35% |
| 心跳批处理 | 310 (+72%) | 10 | 28 (-38%) | 28% |
| Lua 脚本 | 240 (+33%) | 4 | 15 (-67%) | 42% |

### Metadata 性能对比

| 配置 | 成功率 | 平均重试次数 | P99 延迟（ms） |
|------|--------|-------------|---------------|
| 应用层 CAS | 92% | 2.3 | 85 |
| 事务性 Metadata | 100% | 1.1 | 45 |

---

## 监控指标

### 心跳批处理

```typescript
const runtime = await initPresence({ ... });
const batcher = runtime.getHeartbeatBatcher();

// 监控批处理器状态
setInterval(() => {
  const bufferSize = batcher?.getBufferSize() ?? 0;
  console.log('Heartbeat buffer size:', bufferSize);
}, 5000);
```

### Lua 脚本

Lua 脚本执行情况可通过 Redis 监控：

```bash
# 查看 Lua 脚本执行统计
redis-cli INFO stats | grep script

# 查看已加载的脚本
redis-cli SCRIPT LIST
```

### 事务性 Metadata

事务冲突和重试次数会记录在日志中：

```
[DEBUG] Metadata transaction conflict, retry 1/5
[DEBUG] Metadata transaction conflict, retry 2/5
[INFO] Metadata operation succeeded after 2 retries
```

---

## 故障排查

### 问题 1：心跳批处理延迟过高

**症状**：心跳响应时间 > 100ms

**排查**：
1. 检查 `heartbeatBatchWindowMs` 配置是否过大
2. 检查 Redis 网络延迟（`redis-cli --latency`）
3. 检查批次大小是否超过 `heartbeatMaxBatchSize`

**解决**：
- 减小 `heartbeatBatchWindowMs`（如 50ms -> 20ms）
- 减小 `heartbeatMaxBatchSize`（如 100 -> 50）

### 问题 2：Lua 脚本执行失败

**症状**：心跳请求返回 `NOSCRIPT` 错误

**原因**：Redis 重启或脚本被 `SCRIPT FLUSH` 清除

**解决**：脚本会自动重新加载，无需手动干预

### 问题 3：Metadata 事务频繁重试

**症状**：日志中大量 "Metadata transaction conflict" 警告

**原因**：高并发场景下多个客户端同时修改同一 Metadata

**解决**：
- 增加 `metadataMaxRetries`（如 5 -> 10）
- 考虑使用命名锁（`lockName`）串行化更新
- 优化业务逻辑，减少并发冲突

---

## 最佳实践

1. **渐进式启用**：先在测试环境验证，再逐步推广到生产
2. **监控指标**：持续监控吞吐量、延迟、错误率
3. **压力测试**：使用 `backend/benchmark/presence-load-test.mjs` 验证性能
4. **日志分析**：关注 DEBUG 级别日志，了解优化效果
5. **版本兼容**：优化特性向后兼容，可随时禁用

---

## 未来优化方向

以下优化已在架构分析中提出，但未纳入短期计划：

- **Keyspace Notifications + 低频 Reaper**：减少后台任务开销
- **State 压缩与分离存储**：降低内存占用
- **Redlock 分布式锁**：避免死锁，提升可靠性
- **RedisJSON 迁移**：原生 JSON 操作，简化代码
- **用户中心索引**：支持跨房间 Presence 查询

详见 `docs/architecture-analysis.md`。

---

## 参考资料

- [Redis Pipeline](https://redis.io/docs/manual/pipelining/)
- [Redis Lua Scripting](https://redis.io/docs/manual/programmability/eval-intro/)
- [Redis Transactions](https://redis.io/docs/manual/transactions/)
- [架构分析文档](./architecture-analysis.md)

