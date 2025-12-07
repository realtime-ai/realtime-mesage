# Testing Documentation

本文档记录 realtime-mesage 项目的测试现状、覆盖范围和待改进领域。

## 测试概览

| 类别 | 文件数 | 位置 |
|------|--------|------|
| Backend 单元测试 | 4 | `backend/src/presence/` |
| Backend 集成测试 | 1 | `backend/src/presence/integration.test.ts` |
| Backend E2E 测试 | 2 | `backend/src/e2e/` |
| SDK 测试 | 6 | `realtime-message-sdk/src/` |

**测试框架**: Vitest v3.2.4
**Mock 工具**: ioredis-mock, vitest mocks
**测试超时**: 30000ms

## 运行测试

```bash
# 运行所有测试
npm test

# 运行 Backend 测试
npm run test:server

# 运行 SDK 测试
npm run test:sdk

# 运行 E2E 测试 (需要本地 Redis)
REDIS_RUNNING=1 npm run test:e2e

# 运行全部测试 (包括 E2E)
npm run test:all

# 监听模式
npm run test:watch
```

## 测试文件清单

### Backend 测试

| 文件 | 描述 | 状态 |
|------|------|------|
| `backend/src/presence/service.test.ts` | PresenceService 核心功能 | ✅ 完成 |
| `backend/src/presence/service.metadata.test.ts` | Channel Metadata CRUD | ✅ 完成 |
| `backend/src/presence/integration.test.ts` | 多用户场景集成测试 | ✅ 完成 |
| `backend/src/presence/edge-cases.test.ts` | 边界情况处理 | ✅ 完成 |
| `backend/src/presence/handlers.metadata.test.ts` | Metadata Handler 协议测试 | ✅ 完成 |
| `backend/src/e2e/server-sdk.test.ts` | Server + SDK 端到端测试 | ⚠️ 部分 skip |
| `backend/src/e2e/metadata.test.ts` | Metadata E2E 测试 | ✅ 完成 |

### SDK 测试

| 文件 | 描述 | 状态 |
|------|------|------|
| `realtime-message-sdk/src/core/realtime-client.test.ts` | RealtimeClient 核心功能 | ✅ 完成 |
| `realtime-message-sdk/src/modules/presence/presence-channel.test.ts` | PresenceChannel 模块 | ✅ 完成 |
| `realtime-message-sdk/src/modules/channel/channel.test.ts` | Channel 统一 API | ✅ 完成 |
| `realtime-message-sdk/src/modules/channel/channel-presence.test.ts` | Channel Presence | ✅ 完成 |
| `realtime-message-sdk/src/modules/channel/channel-storage.test.ts` | Channel Storage | ✅ 完成 |
| `realtime-message-sdk/src/modules/metadata/channel-metadata-client.test.ts` | Metadata Client | ✅ 完成 |

## 已覆盖的测试场景

### PresenceService 核心功能

- [x] join - 注册连接并返回房间快照
- [x] leave - 清理 Redis 结构
- [x] heartbeat - 状态 patch 和变更检测
- [x] Epoch-based fencing - 拒绝过期 epoch 的写入
- [x] Redis pub/sub 事件订阅
- [x] Socket bridge 事件转发

### 集成测试场景

- [x] 多用户加入同一房间
- [x] 同用户多连接场景
- [x] 用户离开后成员列表更新
- [x] 状态管理 (patch state merge)
- [x] 事件广播 (join/leave/update)
- [x] Active rooms 追踪
- [x] Connection metadata 管理

### 边界情况

- [x] 双重 join 同一 connId
- [x] 双重 leave 同一连接
- [x] 非存在连接的 heartbeat
- [x] 非存在连接的 leave
- [x] Epoch overflow 处理
- [x] 空状态对象
- [x] 嵌套状态对象
- [x] 大状态对象
- [x] 空 patch state
- [x] 相同 patch (无变更检测)
- [x] TTL 刷新
- [x] Reaper 基本清理
- [x] 多订阅者
- [x] 取消订阅
- [x] 订阅者错误处理
- [x] 特殊字符 room ID
- [x] 长 room ID
- [x] Unicode room ID

### Channel Metadata

- [x] setChannelMetadata - 创建/覆盖
- [x] getChannelMetadata - 读取
- [x] updateChannelMetadata - 更新指定项
- [x] removeChannelMetadata - 删除指定项或全部
- [x] majorRevision 版本控制
- [x] item revision 版本控制
- [x] 锁验证 (lockName)
- [x] 事件发布 (set/update/remove)
- [x] 事件订阅
- [x] 错误码 (METADATA_CONFLICT, METADATA_LOCK, METADATA_INVALID)

### SDK RealtimeClient

- [x] 连接管理 (connect/disconnect)
- [x] 连接错误处理
- [x] 重复连接警告
- [x] Auth Provider 集成
- [x] Auth Provider 错误处理
- [x] PresenceChannel 创建
- [x] 重连选项配置
- [x] Logger 集成
- [x] Channel API (channel())
- [x] Shutdown 清理

### SDK PresenceChannel

- [x] join 流程
- [x] leave 流程
- [x] sendHeartbeat
- [x] 自定义事件 emit/on

## 待改进领域

### P0 - 高优先级

#### 1. 并发写入测试

**当前问题**: 缺少真正的并发写入测试
**风险**: 多客户端同时更新状态可能导致数据不一致

**待添加测试**:
- [ ] 多客户端同时 join 同一房间
- [ ] 并发 metadata 更新的冲突检测
- [ ] Epoch fencing 在真实并发下的表现

#### 2. 修复被 skip 的 E2E 测试

**文件**: `backend/src/e2e/server-sdk.test.ts`

**被 skip 的测试**:
- [ ] `should receive presence events when users join/leave`
- [ ] `should receive state change events`

**原因**: 事件监听时序问题

### P1 - 中优先级

#### 3. 真实 Redis 集成测试

**当前问题**: 仅使用 ioredis-mock
**风险**: Lua 脚本、事务、pub/sub 在 mock 中行为可能不一致

**待添加测试**:
- [ ] LuaHeartbeatExecutor 真实 Redis 测试
- [ ] TransactionalMetadataWrapper 真实 Redis 测试
- [ ] Redis Cluster 兼容性测试

#### 4. SDK Heartbeat/Reconnection 测试

**待添加测试**:
- [ ] 自动 heartbeat 定时器启动/停止
- [ ] Heartbeat 间隔配置生效
- [ ] 网络断开后自动重连
- [ ] 重连后状态恢复
- [ ] 重连后 epoch 同步

#### 5. 网络异常场景

**待添加测试**:
- [ ] 网络抖动模拟
- [ ] Heartbeat 超时处理
- [ ] 连接超时处理

### P2 - 低优先级

#### 6. Handlers 单元测试

**文件**: `backend/src/presence/handlers.ts`

**待添加测试**:
- [ ] `presence:join` 错误分支
- [ ] `presence:heartbeat` 与 LuaHeartbeatExecutor 集成
- [ ] `presence:heartbeat` 与 HeartbeatBatcher 集成
- [ ] TransactionalMetadata 相关路径
- [ ] disconnect 清理逻辑

#### 7. Reaper 完整测试

**待添加测试**:
- [ ] TTL 过期后连接被清理
- [ ] Metadata 孤立记录清理
- [ ] 跨节点 reaper 协调
- [ ] Reaper 在高负载下的表现

### P3 - 未来改进

#### 8. 性能测试自动化

**待添加**:
- [ ] 性能回归测试 (单房间 100 用户)
- [ ] 内存泄漏检测
- [ ] 长时间运行稳定性测试
- [ ] Benchmark 结果自动对比

## 未测试的关键代码路径

### Backend

```
backend/src/presence/service.ts:
  - reapRoom() 完整清理逻辑 (L845-908)
  - dispatchEvent() 错误处理 (L797-813)
  - ensureSubscriber() 并发创建 (L738-779)

backend/src/presence/handlers.ts:
  - heartbeat 使用 luaHeartbeatExecutor 路径 (L184-192)
  - heartbeat 使用 heartbeatBatcher 路径 (L195-203)
  - transactionalMetadata 相关路径 (L242-244, 261-263, 280-282)
```

### SDK

```
realtime-message-sdk/src/modules/presence/presence-channel.ts:
  - 自动 heartbeat 定时器管理
  - 断线重连后 epoch 同步

realtime-message-sdk/src/core/realtime-client.ts:
  - Channel dispose 后资源清理
  - 重连事件处理
```

## 测试工具

### 测试辅助函数

位置: `backend/src/test-utils/index.ts`

```typescript
// 创建 Mock Redis
createMockRedis(): RedisClient

// 创建 Mock Logger
createMockLogger(): { debug, info, warn, error }

// 创建 Mock Socket
createMockSocket(id: string): MockSocket

// 等待条件满足
waitFor(condition, timeoutMs, intervalMs): Promise<void>

// 睡眠
sleep(ms): Promise<void>

// 创建测试服务器
createTestServer(): { io, port, close }

// 创建测试客户端
createTestClient(port, options): { socket, disconnect }

// 等待连接
waitForConnect(socket): Promise<void>

// 带超时的 emit
emitWithAck<T>(socket, event, payload, timeoutMs): Promise<T>
```

## 贡献指南

### 添加新测试

1. 在对应模块目录创建 `*.test.ts` 文件
2. 使用 `describe/it` 组织测试
3. 使用 `beforeEach/afterEach` 管理资源
4. 使用 `test-utils` 中的辅助函数
5. 确保测试可独立运行

### 测试命名规范

```typescript
describe("ModuleName", () => {
  describe("MethodName", () => {
    it("should do something when condition", async () => {
      // ...
    });
  });
});
```

### E2E 测试注意事项

- E2E 测试需要本地 Redis
- 使用 `REDIS_RUNNING=1` 环境变量启用
- 每个测试前后清理 Redis 数据
- 使用 `beforeEach` 中的 `redis.flushall()` 确保隔离

---

*最后更新: 2024-12*
