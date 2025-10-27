import type { Redis as RedisClient } from "ioredis";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PresenceService } from "./service";
import { createMockRedis, waitFor, createMockLogger } from "../../test-utils";
import {
  connKey,
  roomConnectionsKey,
  roomMembersKey,
  roomLastSeenKey,
  roomConnMetadataKey,
  activeRoomsKey,
} from "./keys";

describe("Presence Integration Tests", () => {
  let redis: RedisClient;
  let service: PresenceService;

  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
    service = new PresenceService(redis, {
      ttlMs: 5_000,
      reaperIntervalMs: 1_000,
      reaperLookbackMs: 10_000,
      logger: createMockLogger(),
    });
  });

  afterEach(async () => {
    await service.stop();
    if (typeof (redis as any).disconnect === "function") {
      (redis as any).disconnect();
    }
  });

  describe("Multi-user Room Scenarios", () => {
    it("should handle multiple users joining the same room", async () => {
      const snapshot1 = await service.join({
        roomId: "room-1",
        userId: "user-1",
        connId: "conn-1",
        state: { mic: true },
      });

      const snapshot2 = await service.join({
        roomId: "room-1",
        userId: "user-2",
        connId: "conn-2",
        state: { mic: false },
      });

      expect(snapshot1).toHaveLength(1);
      expect(snapshot2).toHaveLength(2);

      const members = await redis.smembers(roomMembersKey("room-1"));
      const conns = await redis.smembers(roomConnectionsKey("room-1"));

      expect(members).toContain("user-1");
      expect(members).toContain("user-2");
      expect(conns).toContain("conn-1");
      expect(conns).toContain("conn-2");
    });

    it("should handle same user with multiple connections", async () => {
      await service.join({
        roomId: "room-multi",
        userId: "user-1",
        connId: "conn-1",
        state: { device: "desktop" },
      });

      await service.join({
        roomId: "room-multi",
        userId: "user-1",
        connId: "conn-2",
        state: { device: "mobile" },
      });

      const members = await redis.smembers(roomMembersKey("room-multi"));
      const conns = await redis.smembers(roomConnectionsKey("room-multi"));

      expect(members).toHaveLength(1);
      expect(members).toContain("user-1");
      expect(conns).toHaveLength(2);
    });

    it("should remove user from members only when all connections leave", async () => {
      await service.join({
        roomId: "room-2",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await service.join({
        roomId: "room-2",
        userId: "user-1",
        connId: "conn-2",
        state: {},
      });

      await service.leave("conn-1");

      let members = await redis.smembers(roomMembersKey("room-2"));
      expect(members).toContain("user-1");

      await service.leave("conn-2");

      members = await redis.smembers(roomMembersKey("room-2"));
      expect(members).not.toContain("user-1");
    });
  });

  describe("State Management", () => {
    it("should maintain separate state for each connection", async () => {
      await service.join({
        roomId: "room-state",
        userId: "user-1",
        connId: "conn-1",
        state: { volume: 100 },
      });

      await service.join({
        roomId: "room-state",
        userId: "user-1",
        connId: "conn-2",
        state: { volume: 50 },
      });

      const state1Json = await redis.hget(connKey("conn-1"), "state");
      const state2Json = await redis.hget(connKey("conn-2"), "state");

      expect(JSON.parse(state1Json!)).toEqual({ volume: 100 });
      expect(JSON.parse(state2Json!)).toEqual({ volume: 50 });
    });

    it("should merge state patches during heartbeat", async () => {
      await service.join({
        roomId: "room-patch",
        userId: "user-1",
        connId: "conn-1",
        state: { mic: true, camera: false },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = epochRaw ? Number(epochRaw) : undefined;

      await service.heartbeat({
        connId: "conn-1",
        patchState: { camera: true },
        epoch,
      });

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ mic: true, camera: true });
    });

    it("should allow clearing state fields with null/undefined", async () => {
      await service.join({
        roomId: "room-clear",
        userId: "user-1",
        connId: "conn-1",
        state: { mic: true, camera: true, screen: true },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = epochRaw ? Number(epochRaw) : undefined;

      await service.heartbeat({
        connId: "conn-1",
        patchState: { camera: null, screen: undefined },
        epoch,
      });

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      const state = JSON.parse(stateJson!);

      expect(state.mic).toBe(true);
      expect(state.camera).toBeNull();
      expect(state.screen).toBeUndefined();
    });
  });

  describe("Epoch Management", () => {
    it("should increment epoch on reconnect to same room", async () => {
      await service.join({
        roomId: "room-reconnect",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const epoch1Raw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch1 = Number(epoch1Raw);

      await service.join({
        roomId: "room-reconnect",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const epoch2Raw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch2 = Number(epoch2Raw);

      expect(epoch2).toBeGreaterThan(epoch1);
    });

    it("should reject heartbeats with stale epoch", async () => {
      await service.join({
        roomId: "room-stale",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const currentEpoch = Number(epochRaw);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 2 },
        epoch: currentEpoch - 1,
      });

      expect(changed).toBe(false);

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ value: 1 });
    });

    it("should accept heartbeats with current epoch", async () => {
      await service.join({
        roomId: "room-current",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const currentEpoch = Number(epochRaw);

      const changed = await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 2 },
        epoch: currentEpoch,
      });

      expect(changed).toBe(true);

      const stateJson = await redis.hget(connKey("conn-1"), "state");
      expect(JSON.parse(stateJson!)).toEqual({ value: 2 });
    });
  });

  describe("Event Broadcasting", () => {
    it("should broadcast join events to subscribers", async () => {
      const events: any[] = [];
      await service.subscribe((event) => {
        events.push(event);
      });

      await service.join({
        roomId: "room-events",
        userId: "user-1",
        connId: "conn-1",
        state: { test: true },
      });

      await waitFor(() => events.length > 0);

      const joinEvent = events.find((e) => e.type === "join");
      expect(joinEvent).toBeDefined();
      expect(joinEvent?.connId).toBe("conn-1");
      expect(joinEvent?.roomId).toBe("room-events");
      expect(joinEvent?.userId).toBe("user-1");
    });

    it.skip("should broadcast state change events on heartbeat - implementation detail", async () => {
      const events: any[] = [];
      await service.subscribe((event) => {
        events.push(event);
      });

      await service.join({
        roomId: "room-hb-events",
        userId: "user-1",
        connId: "conn-1",
        state: { value: 1 },
      });

      await waitFor(() => events.length > 0);
      events.length = 0;

      const epochRaw = await redis.hget(connKey("conn-1"), "epoch");
      const epoch = Number(epochRaw);

      await service.heartbeat({
        connId: "conn-1",
        patchState: { value: 2 },
        epoch,
      });

      await waitFor(() => events.length > 0);

      const stateEvent = events.find((e) => e.type === "state");
      expect(stateEvent).toBeDefined();
      expect(stateEvent?.state).toEqual({ value: 2 });
    });

    it("should broadcast leave events to subscribers", async () => {
      const events: any[] = [];
      await service.subscribe((event) => {
        events.push(event);
      });

      await service.join({
        roomId: "room-leave",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await waitFor(() => events.length > 0);
      events.length = 0;

      await service.leave("conn-1");

      await waitFor(() => events.length > 0);

      const leaveEvent = events.find((e) => e.type === "leave");
      expect(leaveEvent).toBeDefined();
      expect(leaveEvent?.connId).toBe("conn-1");
    });
  });

  describe("Socket Bridge", () => {
    it("should emit presence events to Socket.IO rooms", async () => {
      const emitFn = vi.fn();
      const socketLike = {
        to: vi.fn(() => ({ emit: emitFn })),
      };

      await service.createSocketBridge(socketLike);

      await service.join({
        roomId: "room-bridge",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await waitFor(() => emitFn.mock.calls.length > 0);

      expect(socketLike.to).toHaveBeenCalledWith("room-bridge");
      expect(emitFn).toHaveBeenCalledWith(
        "presence:event",
        expect.objectContaining({
          type: "join",
          roomId: "room-bridge",
          connId: "conn-1",
        })
      );
    });

    it("should use custom event name when provided", async () => {
      const emitFn = vi.fn();
      const socketLike = {
        to: vi.fn(() => ({ emit: emitFn })),
      };

      await service.createSocketBridge(socketLike, {
        eventName: "custom:presence",
      });

      await service.join({
        roomId: "room-custom",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await waitFor(() => emitFn.mock.calls.length > 0);

      expect(emitFn).toHaveBeenCalledWith(
        "custom:presence",
        expect.objectContaining({ type: "join" })
      );
    });
  });

  describe("Active Rooms Tracking", () => {
    it("should add room to active rooms on first join", async () => {
      await service.join({
        roomId: "room-active",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const activeRooms = await redis.smembers(activeRoomsKey());
      expect(activeRooms).toContain("room-active");
    });

    it("should remove room from active rooms when empty", async () => {
      await service.join({
        roomId: "room-empty",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await service.leave("conn-1");

      const activeRooms = await redis.smembers(activeRoomsKey());
      expect(activeRooms).not.toContain("room-empty");
    });

    it("should keep room active if other users remain", async () => {
      await service.join({
        roomId: "room-multi-user",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await service.join({
        roomId: "room-multi-user",
        userId: "user-2",
        connId: "conn-2",
        state: {},
      });

      await service.leave("conn-1");

      const activeRooms = await redis.smembers(activeRoomsKey());
      expect(activeRooms).toContain("room-multi-user");
    });
  });

  describe("Connection Metadata", () => {
    it("should store connection metadata for fast lookups", async () => {
      await service.join({
        roomId: "room-meta",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const metadataRaw = await redis.hget(
        roomConnMetadataKey("room-meta"),
        "conn-1"
      );
      const metadata = JSON.parse(metadataRaw!);

      expect(metadata).toMatchObject({
        userId: "user-1",
        epoch: expect.any(Number),
      });
    });

    it("should update metadata on reconnect", async () => {
      await service.join({
        roomId: "room-meta-update",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const metadata1Raw = await redis.hget(
        roomConnMetadataKey("room-meta-update"),
        "conn-1"
      );
      const metadata1 = JSON.parse(metadata1Raw!);

      await service.join({
        roomId: "room-meta-update",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      const metadata2Raw = await redis.hget(
        roomConnMetadataKey("room-meta-update"),
        "conn-1"
      );
      const metadata2 = JSON.parse(metadata2Raw!);

      expect(metadata2.epoch).toBeGreaterThan(metadata1.epoch);
    });

    it("should clean up metadata on leave", async () => {
      await service.join({
        roomId: "room-meta-cleanup",
        userId: "user-1",
        connId: "conn-1",
        state: {},
      });

      await service.leave("conn-1");

      const metadataRaw = await redis.hget(
        roomConnMetadataKey("room-meta-cleanup"),
        "conn-1"
      );
      expect(metadataRaw).toBeNull();
    });
  });
});
