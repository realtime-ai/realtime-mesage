# Presence & Metadata API 设计分析与改进建议

## 📋 当前设计概览

### Presence API

#### 后端 Socket.IO 事件
```typescript
// 加入房间
socket.on('presence:join', { roomId, userId, state? })
  → { ok, snapshot, self: { connId, epoch } }

// 心跳
socket.on('presence:heartbeat', { patchState?, epoch? })
  → { ok, changed, epoch? }

// 离开房间
socket.on('presence:leave')
  → { ok }

// 事件推送
socket.emit('presence:event', {
  type: 'join' | 'leave' | 'update',
  roomId, userId, connId, state, ts, epoch
})
```

#### SDK 客户端 API
```typescript
// PresenceChannel
await channel.join({ roomId, userId, state? })
await channel.sendHeartbeat({ patchState? })
await channel.updateState(patch)
await channel.leave()
channel.on('presenceEvent', handler)
channel.on('snapshot', handler)
```

### Metadata API

#### 后端 Socket.IO 事件
```typescript
// 设置（覆盖）
socket.on('metadata:setChannel', {
  channelName, channelType, data: [{ key, value, revision? }],
  options?: { majorRevision?, lockName?, addTimestamp?, addUserId? }
})

// 更新（增量）
socket.on('metadata:updateChannel', { channelName, channelType, data, options? })

// 删除
socket.on('metadata:removeChannel', { channelName, channelType, data?, options? })

// 获取
socket.on('metadata:getChannel', { channelName, channelType })

// 事件推送
socket.emit('metadata:event', {
  channelName, channelType, operation: 'set' | 'update' | 'remove',
  items, majorRevision, timestamp, authorUid?
})
```

#### SDK 客户端 API
```typescript
// ChannelMetadataClient
await client.setChannelMetadata(params)
await client.updateChannelMetadata(params)
await client.removeChannelMetadata(params)
await client.getChannelMetadata(params)
client.onChannelEvent(handler)
```

---

## ✅ 设计优点

### 1. 清晰的职责分离
- **Presence**: 专注于实时在线状态和连接管理
- **Metadata**: 专注于频道级别的持久化元数据

### 2. 良好的并发控制机制

#### Presence 使用 Epoch 防护
```typescript
// 单调递增的 epoch 防止过期心跳覆盖新状态
interface PresenceConnectionMetadata {
  userId: string;
  epoch: number;  // 防竞态
}
```

#### Metadata 双层版本控制
```typescript
// majorRevision: 整个 channel 的版本（乐观锁）
// revision: 每个 item 的版本（细粒度冲突检测）
interface ChannelMetadataEntry {
  value: string;
  revision: number;      // 项级版本
  updated?: string;      // 时间戳
  authorUid?: string;    // 作者
}
```

### 3. 灵活的错误处理
```typescript
// 明确的错误类型
MetadataConflictError    // 版本冲突
MetadataLockError        // 锁冲突
MetadataValidationError  // 参数验证失败
```

### 4. 性能优化架构
- **HeartbeatBatcher**: 批处理心跳请求
- **LuaHeartbeatExecutor**: Lua 脚本原子化心跳
- **TransactionalMetadataWrapper**: Redis WATCH/MULTI 事务

---

## 🔍 设计问题与改进建议

### 问题 1: Presence 和 Metadata 概念混淆

#### 当前问题
```typescript
// Presence 既管理在线状态，又存储用户状态
await channel.join({
  roomId: 'room-1',
  userId: 'alice',
  state: { status: 'active', typing: false }  // 这是临时状态
})

// Metadata 管理频道元数据
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'ROOM',
  data: [{ key: 'topic', value: 'Meeting' }]  // 这是持久化数据
})
```

**问题**: 用户很难理解何时用 `state` 何时用 `metadata`

#### 改进建议 A: 明确命名区分

```typescript
// 1. Presence State → Ephemeral State (临时状态)
interface JoinOptions {
  roomId: string;
  userId: string;
  ephemeralState?: Record<string, unknown>;  // 更明确
}

// 2. Channel Metadata → Persistent Metadata (持久化元数据)
interface ChannelMetadataOptions {
  // 保持不变，但文档强调持久化语义
}
```

#### 改进建议 B: 统一 API 层级

```typescript
// 将 Metadata 作为 Presence 的子模块
class PresenceChannel {
  // 现有 API
  async join(params)
  async sendHeartbeat(params)

  // 新增：统一访问点
  get metadata(): ChannelMetadata {
    return new ChannelMetadata(this.socket, this.roomId)
  }
}

// 使用方式
const channel = client.createPresenceChannel()
await channel.join({ roomId: 'room-1', userId: 'alice' })
await channel.metadata.set({ topic: 'Meeting' })  // 更直观
```

---

### 问题 2: Metadata API 参数冗余

#### 当前问题
```typescript
// 每次调用都需要传递 channelName 和 channelType
await client.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [{ key: 'topic', value: 'Meeting' }]
})

await client.updateChannelMetadata({
  channelName: 'room-1',  // 重复
  channelType: 'MESSAGE', // 重复
  data: [{ key: 'topic', value: 'Updated' }]
})
```

#### 改进建议: Scoped Metadata Client

```typescript
// 创建作用域客户端
const roomMetadata = client.channelMetadata('MESSAGE', 'room-1')

// 简化调用
await roomMetadata.set([{ key: 'topic', value: 'Meeting' }])
await roomMetadata.update([{ key: 'topic', value: 'Updated' }])
await roomMetadata.remove(['topic'])
const data = await roomMetadata.get()

// 实现
class ScopedChannelMetadata {
  constructor(
    private client: ChannelMetadataClient,
    private channelType: string,
    private channelName: string
  ) {}

  async set(data: ChannelMetadataItemInput[], options?: ChannelMetadataOptions) {
    return this.client.setChannelMetadata({
      channelType: this.channelType,
      channelName: this.channelName,
      data,
      options
    })
  }

  // ... 其他方法类似
}
```

---

### 问题 3: Set vs Update 语义不明确

#### 当前问题
```typescript
// set: 覆盖所有 metadata（但实际上只设置传入的 key）
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [{ key: 'topic', value: 'Meeting' }]
})
// 期望：清空所有旧数据，只保留 topic
// 实际：如果之前有其他 key，它们依然存在？（需要确认）

// update: 增量更新
await metadata.updateChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [{ key: 'moderator', value: 'alice' }]
})
```

#### 改进建议: 重命名为 Replace/Upsert

```typescript
// 方案 A: 更清晰的命名
interface MetadataOperations {
  // replace: 完全替换（清空旧数据）
  replace(data: MetadataItem[], options?: MetadataOptions): Promise<Response>

  // upsert: 插入或更新（保留其他 key）
  upsert(data: MetadataItem[], options?: MetadataOptions): Promise<Response>

  // patch: 必须已存在才能更新
  patch(data: MetadataItem[], options?: MetadataOptions): Promise<Response>

  // remove: 删除指定 key
  remove(keys: string[], options?: MetadataOptions): Promise<Response>

  // clear: 清空所有
  clear(options?: MetadataOptions): Promise<Response>
}

// 方案 B: 保持现有命名，但添加 replaceAll 选项
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [{ key: 'topic', value: 'Meeting' }],
  options: { replaceAll: true }  // 清空其他 key
})
```

---

### 问题 4: Metadata 缺少原子批量操作

#### 当前问题
```typescript
// 场景：同时更新多个字段，要么全部成功，要么全部失败
await metadata.updateChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [
    { key: 'topic', value: 'Updated Topic' },
    { key: 'moderator', value: 'bob' },
    { key: 'pinned', value: 'true' }
  ],
  options: { majorRevision: 5 }
})

// 问题：如果 topic 的 revision 匹配但 moderator 不匹配，
// 目前会抛出错误，但无法部分应用
```

#### 改进建议: 提供批量操作策略

```typescript
interface MetadataBatchOptions extends ChannelMetadataOptions {
  // 批量更新策略
  batchStrategy?: 'all-or-nothing' | 'partial'
}

// all-or-nothing: 默认行为，任何一个失败就全部失败
await metadata.updateChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [...],
  options: { batchStrategy: 'all-or-nothing' }
})

// partial: 返回成功和失败的详情
const result = await metadata.updateChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [...],
  options: { batchStrategy: 'partial' }
})

// 扩展响应类型
interface ChannelMetadataResponsePartial extends ChannelMetadataResponse {
  succeeded: string[];  // 成功的 key
  failed: Array<{ key: string; reason: string }>;
}
```

---

### 问题 5: Presence State 缺少类型安全

#### 当前问题
```typescript
// state 是完全动态的，缺少类型约束
await channel.join({
  roomId: 'room-1',
  userId: 'alice',
  state: { status: 'active', typing: false }
})

// 其他地方可能写成
await channel.updateState({ status: 'away', typping: true })  // 拼写错误
```

#### 改进建议: 泛型支持

```typescript
// SDK 支持泛型
interface UserPresenceState {
  status: 'active' | 'away' | 'offline';
  typing: boolean;
  lastActivity: number;
}

const channel = client.createPresenceChannel<UserPresenceState>()

await channel.join({
  roomId: 'room-1',
  userId: 'alice',
  state: {
    status: 'active',
    typing: false,
    lastActivity: Date.now()
  }
})

// TypeScript 会检查类型
await channel.updateState({
  typping: true  // ❌ 编译错误
})
```

---

### 问题 6: Lock 机制不够直观

#### 当前问题
```typescript
// 需要手动管理 lock 的生命周期
await redis.set('prs:lock:room-1', 'alice', 'EX', 30)

await metadata.updateChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [...],
  options: { lockName: 'room-1' },
  actorUserId: 'alice'
})

// 使用后需要手动删除
await redis.del('prs:lock:room-1')
```

#### 改进建议: 提供 Lock API

```typescript
// 方案 A: 高级 API with 自动释放
await client.withLock('room-1', async (lockedMetadata) => {
  await lockedMetadata.updateChannelMetadata({
    channelName: 'room-1',
    channelType: 'MESSAGE',
    data: [...]
  })
  // 自动释放 lock
})

// 方案 B: 显式 Lock 对象
const lock = await client.acquireLock('room-1', { ttlMs: 30000 })
try {
  await metadata.updateChannelMetadata({
    channelName: 'room-1',
    channelType: 'MESSAGE',
    data: [...],
    options: { lock }  // 传递 lock 对象而不是字符串
  })
} finally {
  await lock.release()
}

// Lock 接口
interface MetadataLock {
  lockName: string;
  ownerId: string;
  release(): Promise<void>;
  extend(ttlMs: number): Promise<void>;
}
```

---

### 问题 7: 事件订阅缺少过滤能力

#### 当前问题
```typescript
// Metadata 事件无法过滤，只能监听所有 channel
client.onChannelEvent((event) => {
  // 收到所有 channel 的事件，需要手动过滤
  if (event.channelName === 'room-1' && event.channelType === 'MESSAGE') {
    // 处理
  }
})
```

#### 改进建议: 支持 Channel 订阅

```typescript
// 方案 A: 订阅特定 channel
const subscription = client.subscribeToChannel('MESSAGE', 'room-1', (event) => {
  // 只收到 room-1 的事件
})
await subscription.unsubscribe()

// 方案 B: 使用 Scoped Client（配合前面的建议）
const roomMetadata = client.channelMetadata('MESSAGE', 'room-1')
roomMetadata.on('updated', (event) => {
  // 只收到当前 channel 的更新事件
})
```

---

### 问题 8: Metadata Value 限制为 String

#### 当前问题
```typescript
// 所有 value 必须是 string
interface ChannelMetadataEntry {
  value: string;  // 只能是字符串
  revision: number;
}

// 使用时需要手动序列化
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [
    { key: 'config', value: JSON.stringify({ theme: 'dark', lang: 'en' }) }
  ]
})
```

#### 改进建议: 支持 JSON Value

```typescript
// 方案 A: 泛型 Value
interface ChannelMetadataEntry<T = unknown> {
  value: T;
  revision: number;
  updated?: string;
  authorUid?: string;
}

// 使用时自动序列化
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE',
  data: [
    { key: 'config', value: { theme: 'dark', lang: 'en' } }
  ]
})

// 方案 B: 添加 valueType 标记
interface ChannelMetadataEntry {
  value: string;
  valueType?: 'string' | 'json' | 'number' | 'boolean';
  revision: number;
}

// 客户端自动解析
const config = await metadata.getChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE'
})
// config.metadata.config.value 自动解析为对象
```

---

## 🎯 综合改进方案

### 推荐方案：分层 API 设计

```typescript
// ===== Layer 1: 低级 API（保持向后兼容）=====
class ChannelMetadataClient {
  async setChannelMetadata(params: ChannelMetadataMutationParams)
  async updateChannelMetadata(params: ChannelMetadataMutationParams)
  async removeChannelMetadata(params: ChannelMetadataRemovalParams)
  async getChannelMetadata(params: ChannelMetadataGetParams)
}

// ===== Layer 2: 高级 API（推荐使用）=====
class RealtimeClient {
  // Presence Channel（现有）
  createPresenceChannel<TState = unknown>(options?: PresenceChannelOptions): PresenceChannel<TState>

  // 新增：Scoped Metadata
  channelMetadata(
    channelType: string,
    channelName: string
  ): ScopedChannelMetadata

  // 新增：Lock 管理
  async acquireLock(
    lockName: string,
    options?: { ttlMs?: number; userId?: string }
  ): Promise<MetadataLock>

  async withLock<T>(
    lockName: string,
    callback: (lock: MetadataLock) => Promise<T>,
    options?: { ttlMs?: number }
  ): Promise<T>
}

// ===== ScopedChannelMetadata API =====
class ScopedChannelMetadata {
  // CRUD 操作
  async set(items: MetadataItem[], options?: MetadataOptions): Promise<Response>
  async upsert(items: MetadataItem[], options?: MetadataOptions): Promise<Response>
  async patch(items: MetadataItem[], options?: MetadataOptions): Promise<Response>
  async remove(keys: string[], options?: MetadataOptions): Promise<Response>
  async clear(options?: MetadataOptions): Promise<Response>
  async get(): Promise<ChannelMetadataResponse>

  // 单项操作（便捷方法）
  async getItem(key: string): Promise<MetadataEntry | null>
  async setItem(key: string, value: unknown, options?: MetadataOptions): Promise<void>
  async removeItem(key: string, options?: MetadataOptions): Promise<void>

  // 事件订阅
  on(event: 'updated' | 'removed', handler: (event) => void): () => void

  // Lock 支持
  async withLock<T>(callback: (metadata: this) => Promise<T>): Promise<T>
}

// ===== 使用示例 =====
const client = new RealtimeClient(socket)

// Presence（保持不变）
const channel = client.createPresenceChannel<UserPresenceState>()
await channel.join({ roomId: 'room-1', userId: 'alice', state: { status: 'active' } })

// Metadata（新 API）
const roomMeta = client.channelMetadata('MESSAGE', 'room-1')

// 简单使用
await roomMeta.setItem('topic', 'Daily Standup')
const topic = await roomMeta.getItem('topic')

// 批量操作
await roomMeta.upsert([
  { key: 'topic', value: 'Updated Topic' },
  { key: 'moderator', value: 'alice' }
], { addTimestamp: true, addUserId: true })

// 带锁操作
await roomMeta.withLock(async (lockedMeta) => {
  const current = await lockedMeta.get()
  await lockedMeta.upsert([
    { key: 'counter', value: (Number(current.metadata.counter?.value || 0) + 1).toString() }
  ])
})

// 订阅事件
roomMeta.on('updated', (event) => {
  console.log('Metadata updated:', event.items)
})
```

---

## 📊 优先级建议

### 高优先级（立即改进）
1. **✅ 添加 Scoped Metadata API** - 减少参数冗余
2. **✅ 改进 Lock API** - 提供 `withLock` 便捷方法
3. **✅ 支持 Metadata 事件过滤** - 避免客户端手动过滤

### 中优先级（下一个版本）
4. **⚠️ 重命名 set/update** - 改为 replace/upsert，语义更清晰
5. **⚠️ Presence State 泛型支持** - 提升类型安全
6. **⚠️ 支持 JSON Value** - 自动序列化/反序列化

### 低优先级（长期优化）
7. **📌 统一 Presence 和 Metadata** - 将 Metadata 集成到 PresenceChannel
8. **📌 批量操作策略** - 支持 partial 模式

---

## 🔧 实施建议

### 阶段 1: 向后兼容增强
- 保留所有现有 API
- 添加新的高级 API（ScopedChannelMetadata）
- 标记旧 API 为 `@deprecated`（但不移除）

### 阶段 2: 文档和迁移指南
- 更新文档，推荐使用新 API
- 提供迁移示例
- 在 CHANGELOG 中说明变更

### 阶段 3: 逐步移除（可选）
- 在主版本升级时移除 deprecated API
- 或者永久保留作为低级 API

---

## 📝 总结

### 当前设计的核心优势
- ✅ 清晰的职责分离（Presence vs Metadata）
- ✅ 强大的并发控制（Epoch + Revision）
- ✅ 灵活的优化机制（Batching + Lua + Transactional）

### 主要改进方向
- 🎯 **简化 API** - 减少重复参数，提供作用域客户端
- 🎯 **提升类型安全** - 泛型支持，明确语义
- 🎯 **增强便利性** - Lock 自动管理，事件过滤，JSON 值支持

### 建议实施路径
1. 先实现 **Scoped Metadata API**（最小改动，最大收益）
2. 然后添加 **Lock 便捷方法**（提升开发体验）
3. 最后考虑 **泛型和 JSON 支持**（长期优化）

这样既能保持向后兼容，又能逐步提升 API 质量。
