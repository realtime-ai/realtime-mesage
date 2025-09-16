import type { Redis as RedisClient } from "ioredis";
import Redis from "ioredis-mock";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  activeRoomsKey,
  connKey,
  roomConnectionsKey,
  roomMembersKey,
} from "./redis-keys";
import { PresenceService } from "./presence-service";

const redisFactory = () => new (Redis as unknown as { new (): RedisClient })();
const waitFor = async (
  condition: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Condition not met within timeout");
};

describe("PresenceService", () => {
  let redis: RedisClient;
  let service: PresenceService;

  beforeEach(async () => {
    redis = redisFactory();
    await redis.flushall();
    service = new PresenceService(redis, {
      ttlMs: 5_000,
      reaperIntervalMs: 1_000,
      reaperLookbackMs: 10_000,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
  });

  afterEach(async () => {
    await service.stop();
    if (typeof (redis as any).disconnect === "function") {
      (redis as any).disconnect();
    }
  });

  it("registers a connection on join and returns the room snapshot", async () => {
    const snapshot = await service.join({
      roomId: "room-1",
      userId: "user-1",
      connId: "conn-1",
      state: { mic: true },
    });

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      connId: "conn-1",
      userId: "user-1",
      state: { mic: true },
    });

    const members = await redis.smembers(roomMembersKey("room-1"));
    const conns = await redis.smembers(roomConnectionsKey("room-1"));
    expect(members).toContain("user-1");
    expect(conns).toContain("conn-1");
  });

  it("patches state during heartbeat and reports whether it changed", async () => {
    await service.join({
      roomId: "room-2",
      userId: "user-2",
      connId: "conn-2",
      state: { typing: false },
    });

    const changed = await service.heartbeat({
      connId: "conn-2",
      patchState: { typing: true },
    });

    expect(changed).toBe(true);

    const stateJson = await redis.hget(connKey("conn-2"), "state");
    expect(stateJson && JSON.parse(stateJson)).toMatchObject({ typing: true });

    const noChange = await service.heartbeat({
      connId: "conn-2",
      patchState: { typing: true },
    });
    expect(noChange).toBe(false);
  });

  it("cleans up redis structures on leave", async () => {
    await service.join({
      roomId: "room-3",
      userId: "user-3",
      connId: "conn-3",
      state: {},
    });

    const result = await service.leave("conn-3");
    expect(result).toEqual({ roomId: "room-3", userId: "user-3" });

    const members = await redis.smembers(roomMembersKey("room-3"));
    const conns = await redis.smembers(roomConnectionsKey("room-3"));
    const activeRooms = await redis.smembers(activeRoomsKey());
    expect(members).not.toContain("user-3");
    expect(conns).not.toContain("conn-3");
    expect(activeRooms).not.toContain("room-3");
  });

  it("forwards redis pub/sub events to subscribers", async () => {
    const events: string[] = [];
    const unsubscribe = await service.subscribe((event) => {
      events.push(`${event.type}:${event.connId}`);
    });

    await service.join({
      roomId: "room-4",
      userId: "user-4",
      connId: "conn-4",
      state: {},
    });

    await waitFor(() => events.length > 0);
    expect(events).toContain("join:conn-4");

    await unsubscribe();
  });
});
