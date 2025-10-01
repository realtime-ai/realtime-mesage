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
  roomConnMetadataKey,
  roomConnectionsKey,
  roomLastSeenKey,
  roomMembersKey,
} from "./keys";
import { PresenceService } from "./service";

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
    expect(snapshot[0]?.epoch ?? 0).toBeGreaterThan(0);

    const members = await redis.smembers(roomMembersKey("room-1"));
    const conns = await redis.smembers(roomConnectionsKey("room-1"));
    const metadataRaw = await redis.hget(roomConnMetadataKey("room-1"), "conn-1");
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
    expect(members).toContain("user-1");
    expect(conns).toContain("conn-1");
    expect(metadata).toMatchObject({ userId: "user-1" });
  });

  it("patches state during heartbeat and reports whether it changed", async () => {
    await service.join({
      roomId: "room-2",
      userId: "user-2",
      connId: "conn-2",
      state: { typing: false },
    });

    const epochRaw = await redis.hget(connKey("conn-2"), "epoch");
    const epoch = epochRaw ? Number(epochRaw) : undefined;
    const changed = await service.heartbeat({
      connId: "conn-2",
      patchState: { typing: true },
      epoch,
    });

    expect(changed).toBe(true);

    const stateJson = await redis.hget(connKey("conn-2"), "state");
    expect(stateJson && JSON.parse(stateJson)).toMatchObject({ typing: true });

    const storedEpochRaw = await redis.hget(connKey("conn-2"), "epoch");
    expect(Number(storedEpochRaw)).toBe(epoch);

    const noChange = await service.heartbeat({
      connId: "conn-2",
      patchState: { typing: true },
      epoch,
    });
    expect(noChange).toBe(false);
  });

  it("ignores heartbeat writes that carry a stale epoch", async () => {
    await service.join({
      roomId: "room-stale",
      userId: "user-stale",
      connId: "conn-stale",
      state: {},
    });

    const epochRaw = await redis.hget(connKey("conn-stale"), "epoch");
    const epoch = epochRaw ? Number(epochRaw) : 0;
    const lastSeenBefore = await redis.zscore(
      roomLastSeenKey("room-stale"),
      "conn-stale"
    );

    const changed = await service.heartbeat({
      connId: "conn-stale",
      patchState: { typing: true },
      epoch: epoch - 1,
    });

    expect(changed).toBe(false);

    const lastSeenAfter = await redis.zscore(
      roomLastSeenKey("room-stale"),
      "conn-stale"
    );
    expect(lastSeenAfter).toBe(lastSeenBefore);

    const stateJson = await redis.hget(connKey("conn-stale"), "state");
    expect(stateJson && JSON.parse(stateJson)).toEqual({});
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
    const metadata = await redis.hget(roomConnMetadataKey("room-3"), "conn-3");
    expect(members).not.toContain("user-3");
    expect(conns).not.toContain("conn-3");
    expect(activeRooms).not.toContain("room-3");
    expect(metadata).toBeNull();
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

  it("bridges presence events to socket-style emitters", async () => {
    const emitDefault = vi.fn();
    const socketLike = {
      to: vi.fn(() => ({ emit: emitDefault })),
    };

    const bridgeDefault = await service.createSocketBridge(socketLike);
    await service.join({
      roomId: "room-socket",
      userId: "user-socket",
      connId: "conn-socket",
      state: {},
    });

    await waitFor(() => emitDefault.mock.calls.length > 0);
    expect(socketLike.to).toHaveBeenCalledWith("room-socket");
    expect(emitDefault).toHaveBeenCalledWith(
      "presence:event",
      expect.objectContaining({ roomId: "room-socket", connId: "conn-socket" })
    );
    await bridgeDefault.stop();

    const emitCustom = vi.fn();
    const customSocket = {
      to: vi.fn(() => ({ emit: emitCustom })),
    };

    const bridgeCustom = await service.createSocketBridge(customSocket, {
      eventName: "custom:event",
    });
    await service.join({
      roomId: "room-custom",
      userId: "user-custom",
      connId: "conn-custom",
      state: {},
    });

    await waitFor(() => emitCustom.mock.calls.length > 0);
    expect(customSocket.to).toHaveBeenCalledWith("room-custom");
    expect(emitCustom).toHaveBeenCalledWith(
      "custom:event",
      expect.objectContaining({ roomId: "room-custom", connId: "conn-custom" })
    );
    await bridgeCustom.stop();
  });

  it("increments the epoch when a connection rejoins", async () => {
    await service.join({
      roomId: "room-epoch",
      userId: "user-epoch",
      connId: "conn-epoch",
      state: {},
    });

    const firstEpochRaw = await redis.hget(connKey("conn-epoch"), "epoch");
    const firstEpoch = firstEpochRaw ? Number(firstEpochRaw) : 0;

    await service.join({
      roomId: "room-epoch",
      userId: "user-epoch",
      connId: "conn-epoch",
      state: {},
    });

    const secondEpochRaw = await redis.hget(connKey("conn-epoch"), "epoch");
    const secondEpoch = secondEpochRaw ? Number(secondEpochRaw) : 0;

    expect(secondEpoch).toBeGreaterThan(firstEpoch);

    const metadataRaw = await redis.hget(roomConnMetadataKey("room-epoch"), "conn-epoch");
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
    expect(metadata).toMatchObject({ epoch: secondEpoch });
  });
});
