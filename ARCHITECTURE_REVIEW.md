# Realtime Message 架构分析报告

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser SDK                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │RealtimeClient│──│PresenceChannel│──│ ChannelMetadataClient │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────┬───────────┘  │
│         │                │                        │              │
│         └────────────────┴────────────────────────┘              │
│                          │ Socket.IO                             │
└──────────────────────────┼───────────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────────┐
│                    Backend Server                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    initPresence()                            │ │
│  │  ┌───────────────┐  ┌────────────────┐  ┌────────────────┐  │ │
│  │  │PresenceService│──│HeartbeatBatcher│──│LuaHeartbeat    │  │ │
│  │  │               │  │  (可选优化)      │  │Executor (可选)  │  │ │
│  │  └───────┬───────┘  └────────────────┘  └────────────────┘  │ │
│  │          │                                                   │ │
│  │  ┌───────┴───────────────────────────────────────────────┐  │ │
│  │  │ Socket Handlers: join/heartbeat/leave/metadata:*      │  │ │
│  │  └───────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────────┐
│                        Redis                                     │
│  ┌────────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ prs:conn:<connId>  │  │prs:{room}:conns│  │prs:{room}:meta│  │
│  │ (Hash + TTL)       │  │ (Set)          │  │ (Hash)        │  │
│  └────────────────────┘  └────────────────┘  └───────────────┘  │
│  ┌────────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │prs:{room}:last_seen│  │prs:{room}:events│ │Pub/Sub Bridge │  │
│  │ (ZSet for Reaper)  │  │ (Pub/Sub)      │  │               │  │
│  └────────────────────┘  └────────────────┘  └───────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 二、核心设计决策

| 设计点 | 选择 | 理由 |
|--------|------|------|
| **Epoch Fencing** | 单调递增 epoch 防止过时心跳 | 解决分布式环境下的竞态条件 |
| **TTL 过期** | 连接 Hash 带 TTL，心跳刷新 | 无需显式清理，自动过期 |
| **Reaper 线程** | 后台定时扫描 ZSet | 清理僵尸索引，维护一致性 |
| **Pub/Sub Bridge** | Redis Pub/Sub 广播事件 | 支持多节点水平扩展 |

## 三、潜在架构问题

### 严重问题 (P0)

#### 1. 非原子操作导致的竞态条件

**位置**: `backend/src/presence/service.ts:90-133`

```typescript
// join() 方法中的问题
const epoch = nextEpoch(
  await this.redis.hget(connKey(options.connId), "epoch"),  // 读取
  now
);
// ... 中间可能有其他操作修改了 epoch ...
pipeline.hmset(connKey(options.connId), {
  epoch: epoch.toString(),  // 写入可能覆盖并发更新
});
```

**问题描述**: 读取 epoch 和写入之间存在时间窗口，多个节点并发 join 可能导致 epoch 回退。

**建议修复**: 将 join 逻辑迁移到 Lua 脚本，确保原子性。

---

#### 2. 心跳与 Pipeline 之间的非原子性

**位置**: `backend/src/presence/service.ts:135-203`

```typescript
async heartbeat(options: HeartbeatOptions): Promise<boolean> {
  const details = await this.redis.hgetall(key);  // 第一次读取
  // ... 时间窗口 ...
  const pipeline = this.redis.multi();
  // ... 基于旧数据做决策 ...
  await pipeline.exec();  // 写入

  // 又一个独立操作！
  if (effectiveEpoch !== currentEpoch) {
    await this.redis.hset(roomConnMetadataKey, ...);  // 非原子
  }
}
```

**问题描述**: `pipeline.exec()` 后又有独立的 `hset` 操作，如果中间失败会导致数据不一致。

---

#### 3. Metadata 事务包装器未发布事件到 Pub/Sub

**位置**: `backend/src/presence/metadata-transactional.ts`

`TransactionalMetadataWrapper` 实现了 `setChannelMetadata`、`updateChannelMetadata` 等方法，但**没有调用 `publishMetadataEvent()`**，导致使用事务性包装器时其他节点无法收到元数据变更事件。

```typescript
// metadata-transactional.ts - 缺少 publishMetadataEvent 调用
async setChannelMetadata(params): Promise<ChannelMetadataResponse> {
  // ... 逻辑 ...
  await this.redis.multi().hset(...).exec();
  return this.buildMetadataResponse(...);
  // 缺少: await this.publishMetadataEvent(...)
}
```

---

#### 4. 心跳批处理器未发布状态变更事件

**位置**: `backend/src/presence/heartbeat-batcher.ts:157-245`

```typescript
// processBatch() 中只更新了 Redis 数据
if (stateChanged && nextStateJson) {
  writePipeline.hset(key, "state", nextStateJson);
}
// 缺少: 发布 'update' 事件到 Pub/Sub
```

**问题描述**: 使用 `HeartbeatBatcher` 时，状态更新不会广播到其他客户端。

---

### 中等问题 (P1)

#### 5. SDK 客户端存在重复的 channel() 方法定义

**位置**: `realtime-message-sdk/src/core/realtime-client.ts:46-78` 和 `:324-355`

```typescript
// 第一个定义 (行 46)
channel<TPresenceState = unknown, TStorageSchema = Record<string, unknown>>(
  channelId: string,
  options?: { ... }
): Channel<TPresenceState, TStorageSchema> { ... }

// 第二个定义 (行 324) - 完全重复!
channel<TPresenceState = unknown, TStorageSchema = Record<string, unknown>>(
  channelId: string,
  options?: ChannelOptions
): Channel<TPresenceState, TStorageSchema> { ... }
```

**问题描述**: JavaScript 允许重复方法定义（后者覆盖前者），但这表明代码有冗余或合并冲突。

---

#### 6. Reaper 逐个处理连接效率低下

**位置**: `backend/src/presence/service.ts:861-902`

```typescript
for (const connId of staleConnIds) {
  const exists = await this.redis.exists(key);  // 每个连接一次往返
  if (exists) continue;

  const metadataValue = await this.redis.hget(...);  // 又一次往返
  // ...
  await this.redis.multi()...exec();  // 又一次往返
}
```

**问题描述**: 大量过期连接时，Reaper 产生 O(n) 次 Redis 往返，可能造成延迟尖峰。

**建议修复**: 使用 Pipeline 批量检查和清理。

---

#### 7. 离开房间后未清理 Channel 实例

**位置**: `realtime-message-sdk/src/core/realtime-client.ts:196-204`

```typescript
async shutdown(): Promise<void> {
  for (const channel of this.channels.values()) {
    await channel.presence.stop();
    channel.dispose();
  }
  this.channels.clear();  // 只有在 shutdown 时才清理
}
```

**问题描述**: 如果用户调用 `channel.presence.leave()` 离开房间，`this.channels` Map 中的引用不会被移除，可能导致内存泄漏。

---

### 轻微问题 (P2)

#### 8. 硬编码的超时值

| 位置 | 值 | 说明 |
|------|-----|------|
| `presence-channel.ts:246` | 1000ms | leave 超时 |
| `realtime-client.ts:173` | 500ms | disconnect 超时 |
| `heartbeat-batcher.ts:102` | 50ms | 默认批处理窗口 |

**建议修复**: 提取为可配置参数。

---

#### 9. 类型安全问题

**位置**: `realtime-message-sdk/src/core/realtime-client.ts:352`

```typescript
this.channels.set(channelId, channel as Channel);  // 类型断言
```

**问题描述**: 使用 `as` 断言绕过类型检查，可能隐藏类型错误。

---

#### 10. Lua 脚本中的 goto 语法兼容性

**位置**: `backend/src/presence/lua-scripts.ts:158-201`

```lua
if reqEpoch and reqEpoch < currentEpoch then
  table.insert(results, ...)
  goto continue  -- Lua 5.2+ 特性
end
::continue::
```

**问题描述**: `goto` 是 Lua 5.2+ 特性，如果 Redis 使用旧版 Lua 可能不兼容（Redis 7.0+ 使用 Lua 5.1 + goto 支持）。

---

## 四、优化建议优先级

| 优先级 | 问题 | 影响范围 | 修复难度 |
|--------|------|----------|----------|
| P0 | Metadata 事务不发布事件 | 多节点同步失效 | 中 |
| P0 | 心跳批处理器不发布事件 | 状态同步失效 | 中 |
| P0 | Join 操作非原子性 | 数据一致性 | 高 |
| P1 | 重复的 channel() 方法 | 代码维护性 | 低 |
| P1 | Reaper 效率低 | 高负载性能 | 中 |
| P1 | Channel 内存泄漏 | 长期运行内存 | 低 |
| P2 | 硬编码超时值 | 可配置性 | 低 |

---

## 五、架构优势

尽管存在上述问题，项目有以下设计优点：

1. **模块化设计**: `initPresence()` 单入口，清晰的依赖注入
2. **可选优化**: 心跳批处理、Lua 优化、事务性 Metadata 都是可选的
3. **Epoch Fencing**: 有效防止过时更新覆盖新数据
4. **完善的错误处理**: Socket handlers 都有 try/catch 包装
5. **类型安全**: 使用 Zod 验证输入，TypeScript 严格模式
6. **测试覆盖**: 有单元测试、集成测试、边界测试

---

## 六、后续行动建议

### 短期 (1-2 周)
- [ ] 修复 TransactionalMetadataWrapper 不发布事件的问题
- [ ] 修复 HeartbeatBatcher 不发布状态变更事件的问题
- [ ] 清理重复的 channel() 方法定义

### 中期 (2-4 周)
- [ ] 将 join 操作迁移到 Lua 脚本保证原子性
- [ ] 优化 Reaper 使用 Pipeline 批量处理
- [ ] 添加 Channel 离开时的实例清理逻辑

### 长期 (持续)
- [ ] 提取硬编码值为配置参数
- [ ] 添加更多 E2E 测试覆盖多节点场景
- [ ] 考虑添加 Redis Cluster 支持
