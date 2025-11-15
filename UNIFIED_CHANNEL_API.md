# 统一 Channel API 使用指南

## 🎯 概述

新的统一 Channel API 将 **Presence**（在线状态）和 **Storage**（持久化数据）整合到单一入口，提供更简洁、类型安全的开发体验。

### 核心改进

1. **✨ 统一入口** - 一个 channel 包含 presence 和 storage
2. **✨ 语义清晰** - Metadata → Storage（更准确）
3. **✨ 更简洁** - 去掉 channelType，单参数设计
4. **✨ 类型安全** - 完整的 TypeScript 泛型支持

---

## 📦 快速开始

### 定义类型

```typescript
// 用户在线状态
interface UserPresenceState {
  status: 'active' | 'away' | 'offline';
  typing: boolean;
  lastActivity: number;
}

// 房间存储数据
interface RoomStorage {
  topic: string;
  moderator: string;
  pinned: boolean;
  config: {
    theme: 'light' | 'dark';
    lang: string;
  };
}
```

### 创建 Channel

```typescript
import { RealtimeClient } from '@realtime/sdk';

const client = new RealtimeClient({
  baseUrl: 'http://localhost:3000',
});

await client.connect();

// 创建类型安全的 channel
const room = client.channel<UserPresenceState, RoomStorage>('room-123');
```

---

## 🎮 Presence 操作

### 加入/离开

```typescript
// 加入房间
const snapshot = await room.presence.join('alice', {
  status: 'active',
  typing: false,
  lastActivity: Date.now(),
});

console.log('当前在线成员:', snapshot.length);

// 离开房间
await room.presence.leave();
```

### 更新状态

```typescript
// 更新用户状态
await room.presence.updateState({ typing: true });

// 再次更新
await room.presence.updateState({
  status: 'away',
  lastActivity: Date.now(),
});
```

### 获取成员列表

```typescript
const members = room.presence.getMembers();

for (const member of members) {
  console.log(member.userId, member.state);
}
```

### 事件订阅

```typescript
// 用户加入
room.presence.on('joined', (event) => {
  console.log(`${event.userId} 加入了房间`);
});

// 用户离开
room.presence.on('left', (event) => {
  console.log(`${event.userId} 离开了房间`);
});

// 状态更新
room.presence.on('updated', (event) => {
  console.log(`${event.userId} 更新了状态`, event.state);
});
```

---

## 💾 Storage 操作

### 单项操作

```typescript
// 设置值（类型安全）
await room.storage.set('topic', 'Daily Standup Meeting');
await room.storage.set('moderator', 'alice');
await room.storage.set('config', {
  theme: 'dark',
  lang: 'en',
});

// 获取值（自动类型推断）
const topic = await room.storage.get('topic');
// TypeScript 知道 topic 是 string

const config = await room.storage.get('config');
// TypeScript 知道 config 是 { theme: 'light' | 'dark'; lang: string }

// 删除值
await room.storage.remove('pinned');
```

### 批量操作

```typescript
// 批量设置（增量更新，保留其他 key）
await room.storage.setMany({
  topic: 'Updated Topic',
  moderator: 'bob',
  pinned: true,
});

// 批量删除
await room.storage.removeMany(['pinned', 'topic']);

// 清空所有
await room.storage.clear();

// 获取所有数据
const allData = await room.storage.getAll();
console.log('存储的数据:', allData.storage);
console.log('总数:', allData.totalCount);
console.log('版本:', allData.majorRevision);
```

### 带锁操作

```typescript
// 自动管理 lock，确保原子性
await room.storage.withLock(async (storage) => {
  const current = await storage.getAll();

  // 在锁保护下更新
  await storage.set('counter', current.storage.counter + 1);

  // lock 会自动释放
});
```

### 版本控制

```typescript
// 使用乐观锁（majorRevision）
await room.storage.setMany(
  {
    topic: 'New Topic',
  },
  {
    majorRevision: 5, // 只有当前版本为 5 时才更新
  }
);

// 添加时间戳和作者信息
await room.storage.set(
  'moderator',
  'alice',
  {
    addTimestamp: true,
    addUserId: true,
  }
);
```

### 事件订阅

```typescript
// Storage 更新事件
room.storage.on('updated', (event) => {
  console.log('更新的 keys:', event.keys);
  console.log('版本:', event.majorRevision);
  console.log('作者:', event.authorUid);
});

// Storage 删除事件
room.storage.on('removed', (event) => {
  console.log('删除的 keys:', event.keys);
});
```

---

## 🚀 便捷方法

Channel 提供了一些便捷方法，代理到子模块：

```typescript
// join() → presence.join()
await room.join('alice', { status: 'active', typing: false });

// leave() → presence.leave()
await room.leave();

// get() → storage.get()
const topic = await room.get('topic');

// set() → storage.set()
await room.set('topic', 'New Topic');

// remove() → storage.remove()
await room.remove('pinned');
```

---

## 🎪 Channel 级别的统一事件

可以在 channel 级别订阅所有事件：

```typescript
// Presence 事件
room.on('presence:joined', (event) => {
  console.log('用户加入:', event.userId);
});

room.on('presence:left', (event) => {
  console.log('用户离开:', event.userId);
});

room.on('presence:updated', (event) => {
  console.log('状态更新:', event.userId, event.state);
});

// Storage 事件
room.on('storage:updated', (event) => {
  console.log('Storage 更新:', event.keys);
});

room.on('storage:removed', (event) => {
  console.log('Storage 删除:', event.keys);
});
```

---

## 🔄 迁移指南

### 从旧 API 迁移

旧 API 仍然可用（向后兼容），但推荐迁移到新 API：

```typescript
// ❌ 旧 API
const presenceChannel = client.createPresenceChannel();
await presenceChannel.join({
  roomId: 'room-1',
  userId: 'alice',
  state: { status: 'active' },
});

const metadata = client.metadata;
await metadata.setChannelMetadata({
  channelName: 'room-1',
  channelType: 'MESSAGE', // 不再需要
  data: [{ key: 'topic', value: 'Meeting' }],
});

// ✅ 新 API
const room = client.channel<UserState, RoomStorage>('room-1');

await room.presence.join('alice', { status: 'active' });
await room.storage.set('topic', 'Meeting');
```

### 主要变化

| 旧 API | 新 API | 说明 |
|--------|--------|------|
| `createPresenceChannel()` | `channel().presence` | 统一入口 |
| `client.metadata` | `channel().storage` | 重命名 + 作用域化 |
| `channelType` 参数 | ❌ 移除 | 简化为单参数 |
| `setChannelMetadata(...)` | `storage.set(key, value)` | 单项操作更简洁 |
| `updateChannelMetadata(...)` | `storage.setMany({...})` | 语义更清晰 |
| 每次传递 `channelName` | 只传一次 | 减少重复 |

---

## 📚 完整示例

参考 `realtime-message-sdk/examples/unified-channel-example.ts` 查看完整的使用示例。

---

## 🎨 类型安全的最佳实践

### 1. 定义清晰的 Schema

```typescript
// 使用 interface 而不是 type
interface RoomStorage {
  // 使用具体的类型而不是 any
  topic: string;
  moderator: string;

  // 使用联合类型限制可选值
  theme: 'light' | 'dark';

  // 复杂对象也要定义类型
  config: {
    notifications: boolean;
    lang: string;
  };
}
```

### 2. 利用类型推断

```typescript
const room = client.channel<UserState, RoomStorage>('room-1');

// TypeScript 自动知道 topic 是 string
const topic = await room.storage.get('topic');

// 编译时检查，避免拼写错误
await room.storage.set('topik', 'value'); // ❌ 编译错误
```

### 3. 使用泛型约束

```typescript
// 可以为不同房间类型定义不同的 schema
type MessageRoomStorage = {
  topic: string;
  pinned: boolean;
};

type VoiceRoomStorage = {
  speakerId: string;
  muted: boolean;
};

const messageRoom = client.channel<UserState, MessageRoomStorage>('msg-1');
const voiceRoom = client.channel<UserState, VoiceRoomStorage>('voice-1');
```

---

## 💡 常见问题

### Q: 旧 API 会被移除吗？

A: 不会立即移除。旧 API 会标记为 `@deprecated`，但会保留以确保向后兼容。建议逐步迁移到新 API。

### Q: channelType 为什么被移除？

A: 大多数使用场景不需要类型命名空间。如果确实需要，可以通过命名约定实现：`channel('message:room-1')` 或 `channel('voice:room-1')`。

### Q: Storage 和 Metadata 有什么区别？

A: 只是重命名。"Metadata" 容易与"元数据"混淆，而"Storage"更直白地表达了存储数据的用途。

### Q: 如何处理并发更新？

A: 使用 `majorRevision`（乐观锁）或 `withLock()`（悲观锁）：

```typescript
// 乐观锁
await room.storage.setMany({ topic: 'New' }, { majorRevision: 5 });

// 悲观锁
await room.storage.withLock(async (storage) => {
  const data = await storage.getAll();
  await storage.set('counter', data.storage.counter + 1);
});
```

---

## 📖 相关文档

- [API_DESIGN_REVIEW.md](./API_DESIGN_REVIEW.md) - 完整的 API 设计分析
- [realtime-message-sdk/examples/](./realtime-message-sdk/examples/) - 更多示例代码
- [CLAUDE.md](./CLAUDE.md) - 项目总览

---

## ✅ 总结

新的统一 Channel API 提供了：

- ✨ **更简洁** - 单参数设计，无重复
- ✨ **更直观** - 一个 channel = presence + storage
- ✨ **更安全** - 完整的 TypeScript 类型支持
- ✨ **更强大** - 单项操作、批量操作、锁管理、事件订阅

立即开始使用新 API，享受更好的开发体验！🚀
