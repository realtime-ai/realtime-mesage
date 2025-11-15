/**
 * 统一的 Channel 类型定义
 *
 * Channel 是 Presence 和 Storage 的统一入口
 */

import type { PresenceSnapshotEntry } from '../modules/presence/types';

// ===== Storage 相关类型 =====

/**
 * Storage 选项
 */
export interface StorageOptions {
  /**
   * 主版本号（乐观锁）
   * 如果指定，只有当 storage 的 majorRevision 匹配时才能更新
   */
  majorRevision?: number;

  /**
   * Lock 名称
   * 如果指定，需要持有对应的 lock 才能更新
   */
  lockName?: string;

  /**
   * 是否添加时间戳
   */
  addTimestamp?: boolean;

  /**
   * 是否添加用户 ID
   */
  addUserId?: boolean;
}

/**
 * Storage 条目
 */
export interface StorageEntry {
  /**
   * 值（字符串形式，复杂对象会被 JSON 序列化）
   */
  value: string;

  /**
   * 条目版本号（每次更新递增）
   */
  revision: number;

  /**
   * 更新时间（ISO 8601 格式）
   */
  updated?: string;

  /**
   * 作者用户 ID
   */
  authorUid?: string;
}

/**
 * Storage 响应
 */
export interface StorageResponse {
  /**
   * 时间戳
   */
  timestamp: number;

  /**
   * Channel 名称
   */
  channelName: string;

  /**
   * 总数
   */
  totalCount: number;

  /**
   * 主版本号
   */
  majorRevision: number;

  /**
   * Storage 数据
   */
  storage: Record<string, StorageEntry>;
}

/**
 * Storage 事件类型
 */
export type StorageOperationType = 'set' | 'update' | 'remove';

/**
 * Storage 事件
 */
export interface StorageEvent {
  /**
   * Channel 名称
   */
  channelName: string;

  /**
   * 操作类型
   */
  operation: StorageOperationType;

  /**
   * 受影响的 key 列表
   */
  keys: string[];

  /**
   * 主版本号
   */
  majorRevision: number;

  /**
   * 时间戳
   */
  timestamp: number;

  /**
   * 作者用户 ID
   */
  authorUid?: string;
}

/**
 * Storage 事件映射
 */
export interface StorageEventMap {
  /**
   * Storage 更新事件
   */
  updated: StorageEvent;

  /**
   * Storage 删除事件
   */
  removed: StorageEvent;
}

// ===== Presence 相关类型 =====

/**
 * Presence 成员
 */
export interface PresenceMember<TState = unknown> {
  /**
   * 连接 ID
   */
  connId: string;

  /**
   * 用户 ID
   */
  userId: string;

  /**
   * 用户状态
   */
  state: TState | null;

  /**
   * 最后seen时间
   */
  lastSeenMs: number;

  /**
   * Epoch（防竞态）
   */
  epoch: number;
}

/**
 * Presence 事件类型
 */
export type PresenceEventType = 'join' | 'leave' | 'update';

/**
 * Presence 事件
 */
export interface PresenceEvent<TState = unknown> {
  /**
   * 事件类型
   */
  type: PresenceEventType;

  /**
   * 房间 ID
   */
  roomId: string;

  /**
   * 用户 ID
   */
  userId: string;

  /**
   * 连接 ID
   */
  connId: string;

  /**
   * 状态
   */
  state: TState | null;

  /**
   * 时间戳
   */
  ts: number;

  /**
   * Epoch
   */
  epoch?: number;
}

/**
 * Presence 事件映射
 */
export interface PresenceEventMap<TState = unknown> {
  /**
   * 用户加入
   */
  joined: PresenceEvent<TState>;

  /**
   * 用户离开
   */
  left: PresenceEvent<TState>;

  /**
   * 用户状态更新
   */
  updated: PresenceEvent<TState>;
}

/**
 * Presence 快照
 */
export type PresenceSnapshot<TState = unknown> = Array<PresenceMember<TState>>;

// ===== Channel 统一类型 =====

/**
 * Channel 事件映射
 */
export interface ChannelEventMap<TPresenceState = unknown> {
  /**
   * Presence 用户加入
   */
  'presence:joined': PresenceEvent<TPresenceState>;

  /**
   * Presence 用户离开
   */
  'presence:left': PresenceEvent<TPresenceState>;

  /**
   * Presence 用户更新
   */
  'presence:updated': PresenceEvent<TPresenceState>;

  /**
   * Storage 更新
   */
  'storage:updated': StorageEvent;

  /**
   * Storage 删除
   */
  'storage:removed': StorageEvent;
}
