/**
 * Lua 脚本集合
 * 
 * 将多个 Redis 操作合并为原子脚本，减少网络往返次数（RTT）
 */

/**
 * 心跳 Lua 脚本
 * 
 * 原子化执行心跳操作，包括：
 * 1. 读取连接详情
 * 2. Epoch fencing 检查
 * 3. 更新 last_seen_ms 和 TTL
 * 4. 可选：更新状态（patchState）
 * 5. 更新 last_seen ZSet
 * 6. 可选：更新 epoch 和 conn_meta
 * 
 * KEYS[1]: prs:conn:<connId>
 * KEYS[2]: prs:{room:<roomId>}:last_seen
 * KEYS[3]: prs:{room:<roomId>}:conn_meta
 * 
 * ARGV[1]: connId
 * ARGV[2]: now (timestamp)
 * ARGV[3]: ttlMs
 * ARGV[4]: patchStateJson (JSON string or empty)
 * ARGV[5]: requestedEpoch (number or empty)
 * 
 * Returns: JSON string
 * - Success: {"ok":1,"changed":0|1,"epoch":123}
 * - Error: {"ok":0,"error":"message"}
 */
export const HEARTBEAT_SCRIPT = `
local connKey = KEYS[1]
local roomLastSeenKey = KEYS[2]
local roomConnMetaKey = KEYS[3]

local connId = ARGV[1]
local now = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local patchStateJson = ARGV[4]
local requestedEpoch = ARGV[5]

-- 1. 读取连接详情
local exists = redis.call('EXISTS', connKey)
if exists == 0 then
  return '{"ok":0,"error":"Connection not found"}'
end

local roomId = redis.call('HGET', connKey, 'room_id')
local userId = redis.call('HGET', connKey, 'user_id')
if not roomId or not userId then
  return '{"ok":0,"error":"Invalid connection data"}'
end

local currentEpochStr = redis.call('HGET', connKey, 'epoch')
local currentEpoch = tonumber(currentEpochStr) or 0

-- 2. Epoch fencing 检查
local effectiveEpoch = currentEpoch
if requestedEpoch ~= '' then
  local reqEpoch = tonumber(requestedEpoch)
  if reqEpoch and reqEpoch < currentEpoch then
    return '{"ok":0,"error":"Stale epoch"}'
  end
  if reqEpoch and reqEpoch > currentEpoch then
    effectiveEpoch = reqEpoch
  end
end

-- 3. 检查状态是否变化
local stateChanged = 0
if patchStateJson ~= '' then
  local currentStateJson = redis.call('HGET', connKey, 'state') or '{}'
  
  -- 简单合并：解析 -> 合并 -> 序列化（Lua 5.1 无内置 JSON，使用字符串比较）
  local currentState = cjson.decode(currentStateJson)
  local patchState = cjson.decode(patchStateJson)
  
  for k, v in pairs(patchState) do
    currentState[k] = v
  end
  
  local nextStateJson = cjson.encode(currentState)
  if nextStateJson ~= currentStateJson then
    redis.call('HSET', connKey, 'state', nextStateJson)
    stateChanged = 1
  end
end

-- 4. 更新 last_seen 和 TTL
redis.call('HSET', connKey, 'last_seen_ms', tostring(now))
redis.call('PEXPIRE', connKey, ttlMs)
redis.call('ZADD', roomLastSeenKey, now, connId)

-- 5. 更新 epoch（如果变化）
if effectiveEpoch ~= currentEpoch then
  redis.call('HSET', connKey, 'epoch', tostring(effectiveEpoch))
  
  -- 更新 conn_meta
  local metaJson = cjson.encode({ userId = userId, epoch = effectiveEpoch })
  redis.call('HSET', roomConnMetaKey, connId, metaJson)
end

-- 6. 返回结果
return cjson.encode({
  ok = 1,
  changed = stateChanged,
  epoch = effectiveEpoch
})
`;

/**
 * 批量心跳 Lua 脚本
 * 
 * 一次性处理多个连接的心跳，进一步减少 RTT
 * 
 * KEYS: 动态生成（每个连接 3 个 key）
 * ARGV: 动态生成（每个连接 5 个参数）
 * 
 * Returns: JSON array of results
 */
export const BATCH_HEARTBEAT_SCRIPT = `
local numConns = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local results = {}

for i = 1, numConns do
  local baseIdx = (i - 1) * 3 + 1
  local connKey = KEYS[baseIdx]
  local roomLastSeenKey = KEYS[baseIdx + 1]
  local roomConnMetaKey = KEYS[baseIdx + 2]
  
  local argBaseIdx = (i - 1) * 3 + 4
  local connId = ARGV[argBaseIdx]
  local patchStateJson = ARGV[argBaseIdx + 1]
  local requestedEpoch = ARGV[argBaseIdx + 2]
  
  -- 复用单个心跳逻辑
  local exists = redis.call('EXISTS', connKey)
  if exists == 0 then
    table.insert(results, { connId = connId, ok = 0, error = "Connection not found" })
  else
    local roomId = redis.call('HGET', connKey, 'room_id')
    local userId = redis.call('HGET', connKey, 'user_id')
    
    if not roomId or not userId then
      table.insert(results, { connId = connId, ok = 0, error = "Invalid connection data" })
    else
      local currentEpoch = tonumber(redis.call('HGET', connKey, 'epoch')) or 0
      local effectiveEpoch = currentEpoch
      
      if requestedEpoch ~= '' then
        local reqEpoch = tonumber(requestedEpoch)
        if reqEpoch and reqEpoch < currentEpoch then
          table.insert(results, { connId = connId, ok = 0, error = "Stale epoch" })
          goto continue
        end
        if reqEpoch and reqEpoch > currentEpoch then
          effectiveEpoch = reqEpoch
        end
      end
      
      local stateChanged = 0
      if patchStateJson ~= '' then
        local currentStateJson = redis.call('HGET', connKey, 'state') or '{}'
        local currentState = cjson.decode(currentStateJson)
        local patchState = cjson.decode(patchStateJson)
        
        for k, v in pairs(patchState) do
          currentState[k] = v
        end
        
        local nextStateJson = cjson.encode(currentState)
        if nextStateJson ~= currentStateJson then
          redis.call('HSET', connKey, 'state', nextStateJson)
          stateChanged = 1
        end
      end
      
      redis.call('HSET', connKey, 'last_seen_ms', tostring(now))
      redis.call('PEXPIRE', connKey, ttlMs)
      redis.call('ZADD', roomLastSeenKey, now, connId)
      
      if effectiveEpoch ~= currentEpoch then
        redis.call('HSET', connKey, 'epoch', tostring(effectiveEpoch))
        local metaJson = cjson.encode({ userId = userId, epoch = effectiveEpoch })
        redis.call('HSET', roomConnMetaKey, connId, metaJson)
      end
      
      table.insert(results, {
        connId = connId,
        ok = 1,
        changed = stateChanged,
        epoch = effectiveEpoch
      })
    end
  end
  
  ::continue::
end

return cjson.encode(results)
`;

/**
 * Join Lua 脚本
 *
 * 原子化执行 join 操作，解决 read-then-write 竞态条件
 *
 * KEYS[1]: prs:conn:<connId>
 * KEYS[2]: prs:{room:<roomId>}:members
 * KEYS[3]: prs:{room:<roomId>}:conns
 * KEYS[4]: prs:{room:<roomId>}:last_seen
 * KEYS[5]: prs:{room:<roomId>}:conn_meta
 * KEYS[6]: prs:user:<userId>:conns
 * KEYS[7]: prs:active_rooms
 *
 * ARGV[1]: connId
 * ARGV[2]: userId
 * ARGV[3]: roomId
 * ARGV[4]: stateJson
 * ARGV[5]: now (timestamp)
 * ARGV[6]: ttlMs
 *
 * Returns: JSON string
 * - Success: {"ok":1,"epoch":123}
 * - Error: {"ok":0,"error":"message"}
 */
export const JOIN_SCRIPT = `
local connKey = KEYS[1]
local roomMembersKey = KEYS[2]
local roomConnsKey = KEYS[3]
local roomLastSeenKey = KEYS[4]
local roomConnMetaKey = KEYS[5]
local userConnsKey = KEYS[6]
local activeRoomsKey = KEYS[7]

local connId = ARGV[1]
local userId = ARGV[2]
local roomId = ARGV[3]
local stateJson = ARGV[4]
local now = tonumber(ARGV[5])
local ttlMs = tonumber(ARGV[6])

-- 1. 读取现有 epoch（如果存在）并计算下一个 epoch
local existingEpoch = redis.call('HGET', connKey, 'epoch')
local epoch = now
if existingEpoch then
  local prevEpoch = tonumber(existingEpoch) or 0
  if prevEpoch > 0 then
    epoch = math.max(prevEpoch + 1, now)
  end
end

-- 2. 创建/更新连接 Hash
redis.call('HMSET', connKey,
  'conn_id', connId,
  'user_id', userId,
  'room_id', roomId,
  'last_seen_ms', tostring(now),
  'epoch', tostring(epoch),
  'state', stateJson
)
redis.call('PEXPIRE', connKey, ttlMs)

-- 3. 更新房间索引
redis.call('SADD', roomMembersKey, userId)
redis.call('SADD', roomConnsKey, connId)
redis.call('ZADD', roomLastSeenKey, now, connId)

-- 4. 更新 conn_meta
local metaJson = cjson.encode({ userId = userId, epoch = epoch })
redis.call('HSET', roomConnMetaKey, connId, metaJson)

-- 5. 更新用户连接集合
redis.call('SADD', userConnsKey, connId)

-- 6. 标记房间为活跃
redis.call('SADD', activeRoomsKey, roomId)

-- 7. 返回结果
return cjson.encode({
  ok = 1,
  epoch = epoch
})
`;

/**
 * Lua 脚本 SHA1 缓存
 */
export const scriptSHAs = new Map<string, string>();

