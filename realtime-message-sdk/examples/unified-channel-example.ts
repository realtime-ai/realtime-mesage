/**
 * 统一 Channel API 使用示例
 *
 * 展示如何使用新的 Channel API 来管理 Presence 和 Storage
 */

import { RealtimeClient } from '../src/core/realtime-client';

// ===== 定义类型 =====

/**
 * 用户在线状态
 */
interface UserPresenceState {
  status: 'active' | 'away' | 'offline';
  typing: boolean;
  lastActivity: number;
}

/**
 * 房间 Storage Schema
 */
interface RoomStorage {
  topic: string;
  moderator: string;
  pinned: boolean;
  config: {
    theme: 'light' | 'dark';
    lang: string;
  };
  participants: string[];
}

// ===== 主示例 =====

async function main() {
  // 1️⃣ 创建客户端并连接
  const client = new RealtimeClient({
    baseUrl: 'http://localhost:3000',
    logger: {
      debug: (...args) => console.log('[DEBUG]', ...args),
      info: (...args) => console.log('[INFO]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
    },
  });

  await client.connect();
  console.log('✅ 已连接到服务器');

  // 2️⃣ 创建统一的 Channel 实例
  const room = client.channel<UserPresenceState, RoomStorage>('room-123');
  console.log('✅ 创建 Channel: room-123');

  // ===== Presence 操作 =====

  console.log('\n--- Presence 操作 ---');

  // 加入房间（通过子模块）
  const snapshot = await room.presence.join('alice', {
    status: 'active',
    typing: false,
    lastActivity: Date.now(),
  });
  console.log('✅ Alice 加入房间，当前成员:', snapshot.length);

  // 订阅 presence 事件
  room.presence.on('joined', (event) => {
    console.log(`👤 用户加入: ${event.userId}`);
  });

  room.presence.on('left', (event) => {
    console.log(`👋 用户离开: ${event.userId}`);
  });

  room.presence.on('updated', (event) => {
    console.log(`🔄 用户状态更新: ${event.userId}`, event.state);
  });

  // 更新状态
  await room.presence.updateState({ typing: true });
  console.log('✅ 更新状态: typing = true');

  // 获取成员列表
  const members = room.presence.getMembers();
  console.log('✅ 当前在线成员:', members.map((m) => m.userId));

  // ===== Storage 操作 =====

  console.log('\n--- Storage 操作 ---');

  // 设置单个值（类型安全）
  await room.storage.set('topic', 'Daily Standup Meeting');
  console.log('✅ 设置 topic');

  await room.storage.set('moderator', 'alice');
  console.log('✅ 设置 moderator');

  await room.storage.set('config', {
    theme: 'dark',
    lang: 'en',
  });
  console.log('✅ 设置 config');

  // 获取单个值（类型安全，自动推断）
  const topic = await room.storage.get('topic');
  console.log('📖 当前 topic:', topic); // TypeScript 知道这是 string

  const config = await room.storage.get('config');
  console.log('📖 当前 config:', config); // TypeScript 知道这是 { theme, lang }

  // 批量设置
  await room.storage.setMany({
    topic: 'Updated Topic',
    moderator: 'bob',
    pinned: true,
  });
  console.log('✅ 批量更新多个字段');

  // 订阅 storage 事件
  room.storage.on('updated', (event) => {
    console.log(`💾 Storage 更新:`, event.keys);
  });

  room.storage.on('removed', (event) => {
    console.log(`🗑️ Storage 删除:`, event.keys);
  });

  // 带锁操作
  await room.storage.withLock(async (storage) => {
    const allData = await storage.getAll();
    console.log('🔒 在锁保护下操作，当前数据条数:', allData.totalCount);

    // 在锁保护下更新
    await storage.set('pinned', false);
  });
  console.log('✅ withLock 完成');

  // 删除字段
  await room.storage.remove('pinned');
  console.log('✅ 删除 pinned 字段');

  // 获取所有数据
  const allStorage = await room.storage.getAll();
  console.log('📖 所有 storage 数据:', Object.keys(allStorage.storage));

  // ===== 便捷方法（代理到子模块）=====

  console.log('\n--- 便捷方法 ---');

  // 便捷方法：join（代理到 presence.join）
  const room2 = client.channel<UserPresenceState, RoomStorage>('room-456');
  await room2.join('bob', { status: 'active', typing: false, lastActivity: Date.now() });
  console.log('✅ Bob 通过便捷方法加入 room-456');

  // 便捷方法：set（代理到 storage.set）
  await room2.set('topic', 'Quick Meeting');
  console.log('✅ 通过便捷方法设置 topic');

  // 便捷方法：get（代理到 storage.get）
  const quickTopic = await room2.get('topic');
  console.log('📖 通过便捷方法获取 topic:', quickTopic);

  // ===== Channel 级别的统一事件 =====

  console.log('\n--- Channel 统一事件 ---');

  room.on('presence:joined', (event) => {
    console.log(`[Channel Event] 用户加入: ${event.userId}`);
  });

  room.on('storage:updated', (event) => {
    console.log(`[Channel Event] Storage 更新:`, event.keys);
  });

  // ===== 清理 =====

  console.log('\n--- 清理资源 ---');

  await room.presence.leave();
  console.log('✅ Alice 离开房间');

  await room2.dispose();
  console.log('✅ 销毁 room2 channel');

  await client.shutdown();
  console.log('✅ 客户端关闭');
}

// ===== 运行示例 =====

main().catch((error) => {
  console.error('❌ 示例运行失败:', error);
  process.exit(1);
});
