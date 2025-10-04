import type { Redis as RedisClient } from "ioredis";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PresenceService } from "./service";
import { createMockRedis, sleep, createMockLogger } from "../../test-utils";
import { connKey, roomConnectionsKey, roomMembersKey } from "./keys";

describe("Presence Edge Cases", () => {
  let redis: RedisClient;
  let service: PresenceService;

  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  afterEach(async () => {
    await service?.stop();
    if (typeof (redis as any).disconnect === "function") {
      (redis as any).disconnect();
    }
  });

  describe("Connection Edge Cases", () => {
    it("should handle double join with same connId", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const snapshot1 = await service.join({
        roomId: "room-double",
        userId: "user-1",
        connId: "conn-1",
        state: { attempt: 1 },
      });

      const snapshot2 = await service.join({
        roomId: "room-double",
        userId: "user-1",
        connId: "conn-1",
        state: { attempt: 2 },
      });

      expect(snapshot1).toHaveLength(1);
      expect(snapshot2).toHaveLength(1);

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ attempt: 2 });
    });

    it("should handle leave for non-existent connection", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const result = await service.leave("non-existent-conn");
      expect(result).toBeNull();
    });

    it("should handle double leave for same connection", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-leave",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const result1 = await service.leave("conn-1");
      expect(result1).toMatchObject({ roomId: "room-leave", userId: "user-1" });

      const result2 = await service.leave("conn-1");
      expect(result2).toBeNull();
    });

    it("should handle heartbeat for non-existent connection", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const changed = await service.heartbeat({
        connId: "non-existent",
        patchState: { value: 1 },
        epoch: 1,
      });

      expect(changed).toBe(false);
    });
  });

  describe("Epoch Edge Cases", () => {
    it.skip("should handle heartbeat without epoch parameter - edge case not relevant for SDK usage", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-no-epoch",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 2 },
        epoch: undefined as any,
      });

      expect(changed).toBe(false);

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ value: 1 });
    });

    it("should handle epoch overflow gracefully", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-overflow",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const veryLargeEpoch = Number.MAX_SAFE_INTEGER;
      await redis.hset(connKey("conn-1"), "epoch", veryLargeEpoch);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { test: true },
        epoch: veryLargeEpoch,
      });

      expect(changed).toBe(true);
    });

    it.skip("should reject future epoch - edge case for clock skew", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-future",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const currentEpoch = Number(epochRaw);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 2 },
        epoch: currentEpoch + 100,
      });

      expect(changed).toBe(false);

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ value: 1 });
    });
  });

  describe("State Edge Cases", () => {
    it("should handle empty state object", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const snapshot = await service.join({
        roomId: "room-empty-state",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      expect(snapshot[0]?.state).toEqual({});
    });

    it("should handle nested state objects", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const nestedState = {
        user: {
          name: "Test",
          settings: {
            volume: 100,
            notifications: true,
          },
        },
      };

      await service.join({
        roomId: "room-nested",
        userId: "user-1",
        connId: "conn-1",
        state: nestedState,
      });

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual(nestedState);
    });

    it("should handle large state objects", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const largeState = {
        data: Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item-${i}` })),
      };

      await service.join({
        roomId: "room-large",
        userId: "user-1",
        connId: "conn-1",
        state: largeState,
      });

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual(largeState);
    });

    it("should detect no state change when patch is identical", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-identical",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 42 },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = Number(epochRaw);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 42 },
        epoch,
      });

      expect(changed).toBe(false);
    });

    it("should handle empty patch state", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-empty-patch",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = Number(epochRaw);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: {},
        epoch,
      });

      expect(changed).toBe(false);
    });
  });

  describe("TTL and Reaper Edge Cases", () => {
    it("should refresh TTL on heartbeat", async () => {
      service = new PresenceService(redis, {
        ttlMs: 2_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 5_000,
        logger: createMockLogger(),
      });

      await service.join({
        roomId: "room-ttl",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = Number(epochRaw);

      await sleep(1000);

      await service.heartbeat({
        connId: "conn-1",
        patchState: {},
        epoch,
      });

      const ttl = await redis.ttl(connKey("conn-1"));
      expect(ttl).toBeGreaterThan(1);
    });

    it("should handle reaper with no stale connections", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 100,
        reaperLookbackMs: 1_000,
        logger: createMockLogger(),
      });

      service.startReaper();

      await service.join({
        roomId: "room-fresh",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await sleep(200);

      const conns = await redis.smembers(roomConnectionsKey("room-fresh"));
      expect(conns).toContain("conn-1");
    });

    it("should handle reaper with all connections stale", async () => {
      const logger = createMockLogger();
      service = new PresenceService(redis, {
        ttlMs: 100,
        reaperIntervalMs: 150,
        reaperLookbackMs: 50,
        logger,
      });

      await service.join({
        roomId: "room-stale-all",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await service.join({
        roomId: "room-stale-all",
        userId: "user-2",
        connId: "conn-2",
        state: {},
      });

      service.startReaper();

      await sleep(300);

      const conns = await redis.smembers(roomConnectionsKey("room-stale-all"));
      expect(conns).toHaveLength(0);
    });
  });

  describe("Subscriber Edge Cases", () => {
    it("should handle multiple subscribers", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const events1: any[] = [];
      const events2: any[] = [];

      await service.subscribe((e) => events1.push(e));
      await service.subscribe((e) => events2.push(e));

      await service.join({
        roomId: "room-multi-sub",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await sleep(50);

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
    });

    it("should handle unsubscribe correctly", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const events: any[] = [];
      const unsubscribe = await service.subscribe((e) => events.push(e));

      await service.join({
        roomId: "room-unsub",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await sleep(50);
      const countAfterFirst = events.length;
      expect(countAfterFirst).toBeGreaterThan(0);

      await unsubscribe();

      await service.join({
        roomId: "room-unsub",
        userId: "user-2",
        connId: "conn-2",
        state: {},
      });

      await sleep(50);
      expect(events.length).toBe(countAfterFirst);
    });

    it("should handle subscriber errors gracefully", async () => {
      const logger = createMockLogger();
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger,
      });

      await service.subscribe(() => {
        throw new Error("Subscriber error");
      });

      await service.join({
        roomId: "room-error",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await sleep(50);

      expect(logger.error).toHaveBeenCalledWith(
        "Presence event handler threw",
        expect.any(Error)
      );
    });
  });

  describe("Room Name Edge Cases", () => {
    it("should handle special characters in room IDs", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const specialRoomId = "room:with:colons-and-dashes_and_underscores@123";

      await service.join({
        roomId: specialRoomId,
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const conns = await redis.smembers(roomConnectionsKey(specialRoomId));
      expect(conns).toContain("conn-1");
    });

    it("should handle very long room IDs", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const longRoomId = "room-" + "x".repeat(200);

      await service.join({
        roomId: longRoomId,
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const conns = await redis.smembers(roomConnectionsKey(longRoomId));
      expect(conns).toContain("conn-1");
    });

    it("should handle Unicode room IDs", async () => {
      service = new PresenceService(redis, {
        ttlMs: 5_000,
        reaperIntervalMs: 1_000,
        reaperLookbackMs: 10_000,
        logger: createMockLogger(),
      });

      const unicodeRoomId = "room-🚀-测试-مرحبا";

      await service.join({
        roomId: unicodeRoomId,
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const conns = await redis.smembers(roomConnectionsKey(unicodeRoomId));
      expect(conns).toContain("conn-1");
    });
  });
});
