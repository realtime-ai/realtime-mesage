import type { Socket } from 'socket.io-client';
import { EventEmitter } from './event-emitter';
import { ChannelPresence } from './channel-presence';
import { ChannelStorage } from './channel-storage';
import type { Logger } from './types';
import type {
  ChannelEventMap,
  PresenceSnapshot,
  StorageOptions,
  StorageResponse,
} from './channel-types';

/**
 * Channel 选项
 */
export interface ChannelOptions {
  /**
   * Presence 事件名称
   */
  presenceEventName?: string;

  /**
   * Storage 事件名称
   */
  storageEventName?: string;

  /**
   * 心跳间隔（毫秒）
   */
  heartbeatIntervalMs?: number;

  /**
   * 日志器
   */
  logger?: Logger;
}

/**
 * Channel 类 - Presence 和 Storage 的统一入口
 *
 * 提供统一的 API 来管理：
 * - Presence：用户在线状态
 * - Storage：频道持久化数据
 *
 * @template TPresenceState - Presence state 类型
 * @template TStorageSchema - Storage schema 类型
 *
 * @example
 * ```typescript
 * interface UserState {
 *   status: 'active' | 'away';
 *   typing: boolean;
 * }
 *
 * interface RoomStorage {
 *   topic: string;
 *   moderator: string;
 *   config: { theme: string };
 * }
 *
 * const channel = client.channel<UserState, RoomStorage>('room-1');
 *
 * // Presence 操作
 * await channel.presence.join('alice', { status: 'active', typing: false });
 * await channel.presence.updateState({ typing: true });
 *
 * // Storage 操作
 * await channel.storage.set('topic', 'Daily Standup');
 * const topic = await channel.storage.get('topic');
 *
 * // 便捷方法
 * await channel.join('alice', { status: 'active', typing: false });
 * await channel.set('topic', 'Meeting');
 * ```
 */
export class Channel<
  TPresenceState = unknown,
  TStorageSchema = Record<string, unknown>
> extends EventEmitter<ChannelEventMap<TPresenceState>> {
  private readonly socket: Socket;
  private readonly channelId: string;
  private readonly logger: Logger;

  /**
   * Presence 子模块
   * 管理用户在线状态、加入/离开、状态更新
   */
  public readonly presence: ChannelPresence<TPresenceState>;

  /**
   * Storage 子模块
   * 管理频道持久化数据（key-value 存储）
   */
  public readonly storage: ChannelStorage<TStorageSchema>;

  constructor(
    socket: Socket,
    channelId: string,
    options?: ChannelOptions
  ) {
    super();
    this.socket = socket;
    this.channelId = channelId;
    this.logger = options?.logger || console;

    // 初始化子模块
    this.presence = new ChannelPresence<TPresenceState>(
      socket,
      channelId,
      {
        presenceEventName: options?.presenceEventName,
        heartbeatIntervalMs: options?.heartbeatIntervalMs,
      }
    );

    this.storage = new ChannelStorage<TStorageSchema>(
      socket,
      channelId,
      this.logger,
      options?.storageEventName
    );

    // 转发子模块事件到 channel 级别
    this.setupEventBridging();
  }

  // ===== 便捷方法（代理到子模块）=====

  /**
   * 加入 channel（代理到 presence.join）
   */
  async join(userId: string, state?: TPresenceState): Promise<PresenceSnapshot<TPresenceState>> {
    return this.presence.join(userId, state);
  }

  /**
   * 离开 channel（代理到 presence.leave）
   */
  async leave(): Promise<void> {
    return this.presence.leave();
  }

  /**
   * 获取 storage 值（代理到 storage.get）
   */
  async get<K extends keyof TStorageSchema>(key: K): Promise<TStorageSchema[K] | null> {
    return this.storage.get(key);
  }

  /**
   * 设置 storage 值（代理到 storage.set）
   */
  async set<K extends keyof TStorageSchema>(
    key: K,
    value: TStorageSchema[K],
    options?: StorageOptions
  ): Promise<void> {
    return this.storage.set(key, value, options);
  }

  /**
   * 删除 storage 值（代理到 storage.remove）
   */
  async remove<K extends keyof TStorageSchema>(
    key: K,
    options?: StorageOptions
  ): Promise<void> {
    return this.storage.remove(key, options);
  }

  /**
   * 获取 channel ID
   */
  getChannelId(): string {
    return this.channelId;
  }

  /**
   * 销毁 channel 实例
   */
  async dispose(): Promise<void> {
    await this.presence.dispose();
    this.storage.dispose();
    this.removeAll();
  }

  // ===== 私有方法 =====

  private setupEventBridging(): void {
    // 转发 presence 事件
    this.presence.on('joined', (event) => {
      this.emit('presence:joined', event);
    });

    this.presence.on('left', (event) => {
      this.emit('presence:left', event);
    });

    this.presence.on('updated', (event) => {
      this.emit('presence:updated', event);
    });

    // 转发 storage 事件
    this.storage.on('updated', (event) => {
      this.emit('storage:updated', event);
    });

    this.storage.on('removed', (event) => {
      this.emit('storage:removed', event);
    });
  }
}
