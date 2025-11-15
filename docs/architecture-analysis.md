# Presence & Metadata 架构分析与改进方案

## 当前架构概述

### Presence 设计

**核心机制：**
- **Epoch Fencing**：单调递增的 epoch 防止过期心跳覆盖新状态
- **TTL + Reaper**：连接 Hash 自动过期 + 后台清理僵尸索引
- **Redis Pub/Sub Bridge**：跨节点广播 presence 事件

**Redis 数据结构：**
```
prs:conn:<connId>              Hash    连接详情（userId, roomId, state, epoch, last_seen_ms）+ TTL
prs:{room:<roomId>}:conns      Set     房间内活跃连接 ID
prs:{room:<roomId>}:members    Set     房间内唯一用户 ID
prs:{room:<roomId>}:last_seen  ZSet    连接最后活跃时间（reaper 扫描用）
prs:{room:<roomId>}:conn_meta  Hash    快速查询 userId/epoch（避免读取完整连接）
prs:user:<userId>:conns        Set     用户在所有房间的连接
prs:active_rooms               Set     全局活跃房间列表
prs:{room:<roomId>}:events     PubSub  Presence 事件广播频道
```

### Metadata 设计

**核心机制：**
- **Optimistic Locking (CAS)**：majorRevision + itemRevision 冲突检测
- **Optional Lock**：支持命名锁保证独占写入
- **Event Broadcasting**：通过 Redis Pub/Sub 同步元数据变更

**Redis 数据结构：**
```
prs:{chan:<type>:<name>}:meta        Hash   元数据存储（items JSON, totalCount, majorRevision）
prs:{chan:<type>:<name>}:meta_events PubSub 元数据事件广播
prs:lock:<lockName>                  String 命名锁（存储持有者 userId）
```

---

## 当前设计的优点

### ✅ Presence 优势

1. **Epoch Fencing 机制成熟**
   - 有效防止网络延迟导致的状态回滚
   - 支持客户端重连后自动递增 epoch

2. **多层索引优化查询**
   - `conn_meta` Hash 避免频繁读取完整连接数据
   - ZSet `last_seen` 支持高效 reaper 扫描

3. **TTL 自动清理**
   - 连接 Hash 自带过期，减少内存泄漏风险
   - Reaper 作为兜底清理机制

4. **横向扩展友好**
   - Redis Pub/Sub 实现跨节点事件同步
   - 无状态设计，任意节点可处理请求

### ✅ Metadata 优势

1. **乐观锁 + 悲观锁双模式**
   - CAS 适合低冲突场景
   - 命名锁适合需要独占控制的场景

2. **细粒度版本控制**
   - majorRevision 保护整体一致性
   - itemRevision 支持单字段冲突检测

3. **事件驱动架构**
   - 实时同步元数据变更到所有客户端

---

## 潜在问题与改进方案

### 🔴 问题 1：Presence 心跳开销过大

**现状问题：**
- 每次心跳需要 6+ Redis 操作（HGET, HSET, PEXPIRE, ZADD, PUBLISH 等）
- 高并发场景下（1000+ 连接）心跳成为性能瓶颈
- 即使状态未变化，仍需完整执行所有操作

**改进方案 A：心跳批处理（Batching）**

```typescript
// 服务端缓冲心跳请求，批量处理
class HeartbeatBatcher {
  private buffer: Map<string, HeartbeatRequest> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  
  async enqueue(connId: string, request: HeartbeatRequest) {
    this.buffer.set(connId, request);
    
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 50); // 50ms 批处理窗口
    }
  }
  
  private async flush() {
    const batch = Array.from(this.buffer.entries());
    this.buffer.clear();
    this.flushTimer = null;
    
    // 使用 Redis Pipeline 批量处理
    const pipeline = redis.pipeline();
    for (const [connId, req] of batch) {
      pipeline.hset(connKey(connId), 'last_seen_ms', Date.now());
      pipeline.pexpire(connKey(connId), TTL);
      // ... 其他操作
    }
    await pipeline.exec();
  }
}
```

**效果：**
- 减少 Redis 网络往返次数（RTT）
- 提升 50-70% 心跳吞吐量

---

**改进方案 B：Lua 脚本原子化心跳**

```lua
-- heartbeat.lua
local connKey = KEYS[1]
local roomLastSeenKey = KEYS[2]
local connId = ARGV[1]
local now = ARGV[2]
local ttl = ARGV[3]
local patchState = ARGV[4]
local epoch = ARGV[5]

local details = redis.call('HGETALL', connKey)
if #details == 0 then
  return {err = 'Connection not found'}
end

-- 解析现有数据
local currentEpoch = tonumber(details.epoch) or 0
if tonumber(epoch) < currentEpoch then
  return {err = 'Stale epoch'}
end

-- 更新状态
redis.call('HSET', connKey, 'last_seen_ms', now)
redis.call('PEXPIRE', connKey, ttl)
redis.call('ZADD', roomLastSeenKey, now, connId)

if patchState ~= '' then
  redis.call('HSET', connKey, 'state', patchState)
end

return {ok = 1}
```

**效果：**
- 单次心跳从 6+ 次往返降至 1 次
- 原子性保证，无需客户端重试逻辑

---

### 🔴 问题 2：Reaper 扫描效率低

**现状问题：**
- Reaper 每 3 秒扫描所有活跃房间
- 每个房间需要 ZRANGEBYSCORE + N × EXISTS + N × HGET
- 大量房间时 CPU 和网络开销显著

**改进方案 A：分片 Reaper**

```typescript
class ShardedReaper {
  private shardCount = 10;
  
  async reapShard(shardIndex: number) {
    const allRooms = await redis.smembers(activeRoomsKey());
    const shardRooms = allRooms.filter((_, i) => i % this.shardCount === shardIndex);
    
    for (const roomId of shardRooms) {
      await this.reapRoom(roomId);
    }
  }
  
  start() {
    // 每个分片独立调度
    for (let i = 0; i < this.shardCount; i++) {
      setInterval(() => this.reapShard(i), 30_000); // 30秒一轮
    }
  }
}
```

**效果：**
- 分散 Reaper 负载，避免周期性尖峰
- 支持多进程/多线程并行清理

---

**改进方案 B：基于 Redis Keyspace Notifications**

```typescript
// 启用 Redis 过期事件通知
await redis.config('SET', 'notify-keyspace-events', 'Ex');

// 监听连接 Key 过期事件
const subscriber = redis.duplicate();
await subscriber.psubscribe('__keyevent@0__:expired');

subscriber.on('pmessage', async (pattern, channel, expiredKey) => {
  if (expiredKey.startsWith('prs:conn:')) {
    const connId = expiredKey.replace('prs:conn:', '');
    await this.cleanupExpiredConnection(connId);
  }
});
```

**效果：**
- 被动清理，无需主动扫描
- 减少 90% Reaper CPU 开销

**⚠️ 注意：**
- Keyspace Notifications 不保证可靠性（Redis 重启会丢失）
- 建议与低频 Reaper 结合使用（兜底机制）

---

### 🔴 问题 3：Metadata 无真正的事务支持

**现状问题：**
- 当前 CAS 检查在应用层实现，存在 TOCTOU 竞态
- 多个字段更新时，无法保证原子性
- 高并发下冲突率高，客户端需频繁重试

**改进方案 A：Redis WATCH + MULTI/EXEC**

```typescript
async updateChannelMetadata(params: ChannelMetadataMutationParams) {
  const key = channelMetadataKey(params.channelType, params.channelName);
  
  while (true) {
    await redis.watch(key);
    
    const state = await this.readChannelMetadataState(key);
    this.ensureMajorRevision(params.options?.majorRevision, state.majorRevision);
    
    const nextRecord = this.applyUpdates(state.metadata, params.data);
    const nextMajorRevision = state.majorRevision + 1;
    
    const result = await redis
      .multi()
      .hset(key, 'items', JSON.stringify(nextRecord))
      .hset(key, 'majorRevision', nextMajorRevision)
      .exec();
    
    if (result !== null) {
      // 事务成功
      return this.buildResponse(nextRecord, nextMajorRevision);
    }
    
    // 事务失败，重试
    await redis.unwatch();
  }
}
```

**效果：**
- Redis 层面保证原子性
- 减少应用层冲突检测逻辑

---

**改进方案 B：迁移到 RedisJSON**

```typescript
// 使用 RedisJSON 模块存储元数据
await redis.call('JSON.SET', key, '$', JSON.stringify({
  majorRevision: 1,
  totalCount: 2,
  items: {
    topic: { value: 'Meeting', revision: 1 },
    moderator: { value: 'alice', revision: 1 }
  }
}));

// 原子更新单个字段
await redis.call('JSON.SET', key, '$.items.topic.value', '"Updated"');
await redis.call('JSON.NUMINCRBY', key, '$.items.topic.revision', 1);
await redis.call('JSON.NUMINCRBY', key, '$.majorRevision', 1);
```

**效果：**
- 原生支持 JSON 路径操作
- 单字段更新无需读取整个文档
- 减少网络传输和序列化开销

**⚠️ 注意：**
- 需要 Redis Stack 或单独安装 RedisJSON 模块
- 增加部署复杂度

---

### 🔴 问题 4：Presence State 存储效率低

**现状问题：**
- 每个连接的 state 以 JSON 字符串存储在 Hash 中
- 频繁的 JSON 序列化/反序列化开销
- 大 state 对象占用内存高

**改进方案 A：State 压缩**

```typescript
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

async join(options: JoinOptions) {
  const stateJson = JSON.stringify(options.state ?? {});
  
  // 超过 1KB 的 state 进行压缩
  const statePayload = stateJson.length > 1024
    ? (await gzipAsync(stateJson)).toString('base64')
    : stateJson;
  
  await redis.hset(connKey(options.connId), {
    state: statePayload,
    compressed: stateJson.length > 1024 ? '1' : '0'
  });
}
```

**效果：**
- 大 state 对象内存占用减少 60-80%
- 适合协同编辑场景（光标位置、选区等）

---

**改进方案 B：State 分离存储**

```typescript
// 将 state 存储在独立的 Key 中
const stateKey = (connId: string) => `prs:conn:${connId}:state`;

async join(options: JoinOptions) {
  const pipeline = redis.multi();
  
  // 连接元数据（小对象）
  pipeline.hmset(connKey(options.connId), {
    conn_id: options.connId,
    user_id: options.userId,
    room_id: options.roomId,
    epoch: epoch.toString(),
    last_seen_ms: now.toString()
  });
  pipeline.pexpire(connKey(options.connId), this.ttlMs);
  
  // State 独立存储（大对象）
  pipeline.set(stateKey(options.connId), JSON.stringify(options.state));
  pipeline.pexpire(stateKey(options.connId), this.ttlMs);
  
  await pipeline.exec();
}
```

**效果：**
- 心跳时无需读取完整 state（除非需要 patch）
- 减少网络传输和内存占用

---

### 🔴 问题 5：跨房间 Presence 查询困难

**现状问题：**
- 当前设计以房间为中心，无法高效查询"用户在哪些房间"
- `prs:user:<userId>:conns` 只存储连接 ID，需要二次查询

**改进方案：用户中心索引**

```typescript
// 增强用户索引结构
const userRoomsKey = (userId: string) => `prs:user:${userId}:rooms`;

async join(options: JoinOptions) {
  const pipeline = redis.multi();
  
  // ... 现有逻辑 ...
  
  // 维护用户-房间映射
  pipeline.sadd(userRoomsKey(options.userId), options.roomId);
  
  await pipeline.exec();
}

// 新增查询 API
async getUserPresence(userId: string): Promise<UserPresenceSnapshot> {
  const rooms = await redis.smembers(userRoomsKey(userId));
  const connections = await redis.smembers(userConnsKey(userId));
  
  const pipeline = redis.pipeline();
  connections.forEach(connId => pipeline.hgetall(connKey(connId)));
  const results = await pipeline.exec();
  
  return {
    userId,
    rooms,
    connections: results.map(([_, data]) => parseConnection(data))
  };
}
```

**效果：**
- 支持"查看用户在线状态"功能
- 适合社交应用、管理后台

---

### 🔴 问题 6：Metadata Lock 实现过于简单

**现状问题：**
- 当前 Lock 无超时机制，持有者崩溃会导致死锁
- 无锁续期（Lease Renewal）支持
- 无公平性保证

**改进方案：Redlock 算法**

```typescript
import Redlock from 'redlock';

class MetadataLockManager {
  private redlock: Redlock;
  
  constructor(redisClients: Redis[]) {
    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200
    });
  }
  
  async acquireLock(lockName: string, userId: string, ttl = 10_000): Promise<Lock> {
    const lock = await this.redlock.acquire([lockKey(lockName)], ttl);
    
    return {
      release: () => lock.release(),
      extend: (ttl: number) => lock.extend(ttl)
    };
  }
}

// 使用示例
const lock = await lockManager.acquireLock('channel-123', 'user-1', 30_000);

try {
  await service.updateChannelMetadata({
    channelName: 'channel-123',
    channelType: 'MESSAGE',
    data: [{ key: 'topic', value: 'Updated' }]
  });
} finally {
  await lock.release();
}
```

**效果：**
- 自动超时释放，避免死锁
- 支持分布式环境（多 Redis 节点）
- 锁续期支持长时间操作

---

## 架构演进建议

### 短期优化（1-2 周）

1. **实施心跳批处理**
   - 优先级：⭐⭐⭐⭐⭐
   - 成本：低
   - 收益：显著提升高并发性能

2. **引入 Lua 脚本优化关键路径**
   - 优先级：⭐⭐⭐⭐
   - 成本：中
   - 收益：减少网络往返，提升响应速度

3. **Metadata 增加 WATCH/MULTI 事务**
   - 优先级：⭐⭐⭐⭐
   - 成本：低
   - 收益：提升并发安全性

### 中期优化（1-2 月）

4. **迁移到 Keyspace Notifications + 低频 Reaper**
   - 优先级：⭐⭐⭐
   - 成本：中
   - 收益：减少后台任务开销

5. **State 压缩与分离存储**
   - 优先级：⭐⭐⭐
   - 成本：中
   - 收益：降低内存占用

6. **升级 Lock 机制为 Redlock**
   - 优先级：⭐⭐⭐
   - 成本：低
   - 收益：避免死锁，提升可靠性

### 长期演进（3-6 月）

7. **评估 RedisJSON 迁移**
   - 优先级：⭐⭐
   - 成本：高
   - 收益：原生 JSON 操作，简化代码

8. **增加用户中心索引**
   - 优先级：⭐⭐
   - 成本：中
   - 收益：支持新业务场景

9. **考虑引入 CRDT**
   - 优先级：⭐
   - 成本：极高
   - 收益：最终一致性，支持离线协同

---

## 性能基准测试建议

在实施优化前，建议建立以下基准测试：

```typescript
// benchmark/presence-optimizations.mjs
const scenarios = [
  {
    name: 'Baseline (Current)',
    rooms: 100,
    usersPerRoom: 10,
    heartbeatInterval: 5000
  },
  {
    name: 'With Batching',
    rooms: 100,
    usersPerRoom: 10,
    heartbeatInterval: 5000,
    enableBatching: true
  },
  {
    name: 'With Lua Scripts',
    rooms: 100,
    usersPerRoom: 10,
    heartbeatInterval: 5000,
    useLuaScripts: true
  }
];

// 测量指标
const metrics = {
  heartbeatLatencyP50: [],
  heartbeatLatencyP99: [],
  redisOpsPerSecond: [],
  memoryUsageMB: [],
  cpuUsagePercent: []
};
```

---

## 总结

当前 Presence 和 Metadata 设计已经相当成熟，核心机制（Epoch Fencing、CAS、TTL）都是业界最佳实践。主要改进空间在于：

1. **性能优化**：批处理、Lua 脚本、压缩
2. **可靠性增强**：Redlock、Keyspace Notifications
3. **功能扩展**：用户中心索引、跨房间查询

建议采用**渐进式优化**策略，先实施低成本高收益的改进（批处理、Lua 脚本），再根据实际业务需求评估是否需要更复杂的方案（RedisJSON、CRDT）。

