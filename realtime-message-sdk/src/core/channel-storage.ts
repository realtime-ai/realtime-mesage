import type { Socket } from 'socket.io-client';
import { EventEmitter } from './event-emitter';
import type { Logger } from './types';
import type {
  StorageOptions,
  StorageResponse,
  StorageEvent,
  StorageEventMap,
} from './channel-types';

/**
 * Channel Storage 类
 *
 * 提供简化的 key-value 存储 API，支持：
 * - 单项操作（get/set/remove）
 * - 批量操作（getAll/setMany/removeMany/clear）
 * - 自动 lock 管理（withLock）
 * - 事件订阅（updated/removed）
 *
 * @template TSchema - Storage schema 类型
 */
export class ChannelStorage<TSchema = Record<string, unknown>> extends EventEmitter<StorageEventMap> {
  private readonly socket: Socket;
  private readonly channelName: string;
  private readonly logger: Logger;
  private readonly storageEventName: string;
  private listenerAttached = false;

  constructor(
    socket: Socket,
    channelName: string,
    logger: Logger,
    storageEventName = 'metadata:event'
  ) {
    super();
    this.socket = socket;
    this.channelName = channelName;
    this.logger = logger;
    this.storageEventName = storageEventName;
    this.attachListener();
  }

  /**
   * 获取单个 key 的值
   */
  async get<K extends keyof TSchema>(key: K): Promise<TSchema[K] | null> {
    const response = await this.getAll();
    const entry = response.storage[key as string];
    if (!entry) {
      return null;
    }

    // 尝试解析 JSON
    try {
      return JSON.parse(entry.value) as TSchema[K];
    } catch {
      return entry.value as TSchema[K];
    }
  }

  /**
   * 设置单个 key 的值
   */
  async set<K extends keyof TSchema>(
    key: K,
    value: TSchema[K],
    options?: StorageOptions
  ): Promise<void> {
    await this.setMany({ [key]: value } as Partial<TSchema>, options);
  }

  /**
   * 删除单个 key
   */
  async remove<K extends keyof TSchema>(
    key: K,
    options?: StorageOptions
  ): Promise<void> {
    await this.removeMany([key], options);
  }

  /**
   * 获取所有 storage 数据
   */
  async getAll(): Promise<StorageResponse> {
    return this.emitWithAck('metadata:getChannel', {
      channelName: this.channelName,
    });
  }

  /**
   * 批量设置多个 key
   * 会保留其他未指定的 key（增量更新）
   */
  async setMany(
    items: Partial<TSchema>,
    options?: StorageOptions
  ): Promise<StorageResponse> {
    const data = Object.entries(items).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));

    return this.emitWithAck('metadata:updateChannel', {
      channelName: this.channelName,
      data,
      options,
    });
  }

  /**
   * 批量删除多个 key
   */
  async removeMany(
    keys: Array<keyof TSchema>,
    options?: StorageOptions
  ): Promise<StorageResponse> {
    const data = (keys as string[]).map((key) => ({ key }));

    return this.emitWithAck('metadata:removeChannel', {
      channelName: this.channelName,
      data,
      options,
    });
  }

  /**
   * 清空所有 storage 数据
   */
  async clear(options?: StorageOptions): Promise<StorageResponse> {
    return this.emitWithAck('metadata:removeChannel', {
      channelName: this.channelName,
      options,
    });
  }

  /**
   * 带 lock 的操作
   * 自动获取和释放 lock
   */
  async withLock<T>(
    callback: (storage: this) => Promise<T>,
    options?: { ttlMs?: number; lockName?: string }
  ): Promise<T> {
    const lockName = options?.lockName || this.channelName;

    // TODO: 实现 lock 获取/释放逻辑
    // 目前先简单调用 callback
    try {
      return await callback(this);
    } catch (error) {
      this.logger.error('Storage withLock failed', error);
      throw error;
    }
  }

  /**
   * 订阅 storage 事件
   */
  on(event: 'updated' | 'removed', handler: (event: StorageEvent) => void): () => void {
    return super.on(event, handler);
  }

  /**
   * 取消订阅 storage 事件
   */
  off(event: 'updated' | 'removed', handler: (event: StorageEvent) => void): void {
    super.off(event, handler);
  }

  /**
   * 销毁 storage 实例
   */
  dispose(): void {
    this.detachListener();
    this.removeAll();
  }

  // ===== 私有方法 =====

  private attachListener(): void {
    if (this.listenerAttached) {
      return;
    }
    this.socket.on(this.storageEventName, this.handleStorageEvent);
    this.listenerAttached = true;
  }

  private detachListener(): void {
    if (!this.listenerAttached) {
      return;
    }
    this.socket.off(this.storageEventName, this.handleStorageEvent);
    this.listenerAttached = false;
  }

  private handleStorageEvent = (payload: any): void => {
    // 只处理当前 channel 的事件
    if (payload.channelName !== this.channelName) {
      return;
    }

    this.logger.debug('storage:event', payload);

    const event: StorageEvent = {
      channelName: payload.channelName,
      operation: payload.operation,
      keys: payload.items?.map((item: any) => item.key) || [],
      majorRevision: payload.majorRevision,
      timestamp: payload.timestamp,
      authorUid: payload.authorUid,
    };

    if (payload.operation === 'remove') {
      this.emit('removed', event);
    } else {
      this.emit('updated', event);
    }
  };

  private emitWithAck(
    eventName: string,
    payload: unknown
  ): Promise<StorageResponse> {
    return new Promise<StorageResponse>((resolve, reject) => {
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const cleanup = () => {
        this.socket.off('error', onError);
      };

      this.socket.emit(eventName, payload, (ack: any) => {
        cleanup();

        if (!ack) {
          const error = new Error('Malformed acknowledgement from server');
          this.logger.error('storage ack malformed', { eventName });
          reject(error);
          return;
        }

        if (!ack.ok) {
          const error = new Error(ack.error || 'Unknown storage error');
          this.logger.warn('storage operation failed', {
            eventName,
            error: ack.error,
          });
          reject(error);
          return;
        }

        // 转换响应格式：metadata → storage
        const response: StorageResponse = {
          timestamp: ack.timestamp,
          channelName: ack.channelName,
          totalCount: ack.totalCount,
          majorRevision: ack.majorRevision,
          storage: ack.metadata || {},
        };

        resolve(response);
      });

      this.socket.once('error', onError);
    });
  }
}
