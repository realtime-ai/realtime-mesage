import type { Socket } from 'socket.io-client';
import { EventEmitter } from './event-emitter';
import type {
  PresenceEvent,
  PresenceEventMap,
  PresenceMember,
  PresenceSnapshot,
} from './channel-types';
import type {
  PresenceJoinResponse,
  PresenceHeartbeatResponse,
} from '../modules/presence/types';

/**
 * Channel Presence 类
 *
 * 管理 channel 中的用户在线状态：
 * - join/leave 操作
 * - 自动心跳
 * - 状态更新
 * - 成员列表
 *
 * @template TState - Presence state 类型
 */
export class ChannelPresence<TState = unknown> extends EventEmitter<PresenceEventMap<TState>> {
  private readonly socket: Socket;
  private readonly channelId: string;
  private readonly presenceEventName: string;

  private isJoined = false;
  private currentUserId: string | null = null;
  private connId: string | null = null;
  private epoch: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private members: Map<string, PresenceMember<TState>> = new Map();

  constructor(
    socket: Socket,
    channelId: string,
    options?: {
      presenceEventName?: string;
      heartbeatIntervalMs?: number;
    }
  ) {
    super();
    this.socket = socket;
    this.channelId = channelId;
    this.presenceEventName = options?.presenceEventName || 'presence:event';
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs || 10_000;

    this.attachSocketHandlers();
  }

  /**
   * 加入 channel
   */
  async join(userId: string, state?: TState): Promise<PresenceSnapshot<TState>> {
    if (this.isJoined) {
      throw new Error('Already joined this channel');
    }

    return new Promise<PresenceSnapshot<TState>>((resolve, reject) => {
      const payload = {
        roomId: this.channelId,
        userId,
        state: state || null,
      };

      this.socket.emit('presence:join', payload, (response: PresenceJoinResponse) => {
        if (!response?.ok) {
          reject(new Error(response?.error || 'Join failed'));
          return;
        }

        this.isJoined = true;
        this.currentUserId = userId;
        this.connId = response.self.connId;
        this.epoch = response.self.epoch;

        // 更新成员列表
        this.updateMembersFromSnapshot(response.snapshot);

        // 开始心跳
        this.startHeartbeat();

        resolve(response.snapshot as PresenceSnapshot<TState>);
      });
    });
  }

  /**
   * 更新状态
   */
  async updateState(patch: Partial<TState>): Promise<boolean> {
    if (!this.isJoined) {
      throw new Error('Not joined to channel');
    }

    return new Promise<boolean>((resolve, reject) => {
      const payload = {
        patchState: patch,
        epoch: this.epoch,
      };

      this.socket.emit('presence:heartbeat', payload, (response: PresenceHeartbeatResponse) => {
        if (!response?.ok) {
          reject(new Error(response?.error || 'Update state failed'));
          return;
        }

        if (response.epoch !== undefined) {
          this.epoch = response.epoch;
        }

        resolve(response.changed || false);
      });
    });
  }

  /**
   * 离开 channel
   */
  async leave(): Promise<void> {
    if (!this.isJoined) {
      return;
    }

    this.stopHeartbeat();

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 1000);

      this.socket.emit('presence:leave', undefined, () => {
        clearTimeout(timeout);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 获取当前在线成员列表
   */
  getMembers(): PresenceMember<TState>[] {
    return Array.from(this.members.values());
  }

  /**
   * 订阅 presence 事件
   */
  on(
    event: 'joined' | 'left' | 'updated',
    handler: (event: PresenceEvent<TState>) => void
  ): () => void {
    return super.on(event, handler);
  }

  /**
   * 取消订阅 presence 事件
   */
  off(
    event: 'joined' | 'left' | 'updated',
    handler: (event: PresenceEvent<TState>) => void
  ): void {
    super.off(event, handler);
  }

  /**
   * 销毁 presence 实例
   */
  async dispose(): Promise<void> {
    await this.leave();
    this.detachSocketHandlers();
    this.removeAll();
  }

  // ===== 私有方法 =====

  private attachSocketHandlers(): void {
    this.socket.on(this.presenceEventName, this.handlePresenceEvent);
    this.socket.on('disconnect', this.handleDisconnect);
  }

  private detachSocketHandlers(): void {
    this.socket.off(this.presenceEventName, this.handlePresenceEvent);
    this.socket.off('disconnect', this.handleDisconnect);
  }

  private handlePresenceEvent = (event: any): void => {
    // 只处理当前 channel 的事件
    if (event.roomId !== this.channelId) {
      return;
    }

    const presenceEvent: PresenceEvent<TState> = {
      type: event.type,
      roomId: event.roomId,
      userId: event.userId,
      connId: event.connId,
      state: event.state,
      ts: event.ts,
      epoch: event.epoch,
    };

    // 更新成员列表
    if (event.type === 'join') {
      this.members.set(event.connId, {
        connId: event.connId,
        userId: event.userId,
        state: event.state,
        lastSeenMs: event.ts,
        epoch: event.epoch || 0,
      });
      this.emit('joined', presenceEvent);
    } else if (event.type === 'leave') {
      this.members.delete(event.connId);
      this.emit('left', presenceEvent);
    } else if (event.type === 'update') {
      const member = this.members.get(event.connId);
      if (member) {
        member.state = event.state;
        member.lastSeenMs = event.ts;
        member.epoch = event.epoch || member.epoch;
      }
      this.emit('updated', presenceEvent);
    }
  };

  private handleDisconnect = (): void => {
    this.cleanup();
  };

  private startHeartbeat(): void {
    this.stopHeartbeat();

    if (this.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        console.error('Heartbeat failed:', error);
      });
    }, this.heartbeatIntervalMs);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.isJoined) {
      return;
    }

    return new Promise<void>((resolve) => {
      const payload = {
        epoch: this.epoch,
      };

      this.socket.emit('presence:heartbeat', payload, (response: PresenceHeartbeatResponse) => {
        if (response?.ok && response.epoch !== undefined) {
          this.epoch = response.epoch;
        }
        resolve();
      });
    });
  }

  private updateMembersFromSnapshot(snapshot: any[]): void {
    this.members.clear();
    for (const entry of snapshot) {
      this.members.set(entry.connId, {
        connId: entry.connId,
        userId: entry.userId,
        state: entry.state,
        lastSeenMs: entry.lastSeenMs,
        epoch: entry.epoch,
      });
    }
  }

  private cleanup(): void {
    this.isJoined = false;
    this.currentUserId = null;
    this.connId = null;
    this.epoch = 0;
    this.members.clear();
    this.stopHeartbeat();
  }
}
