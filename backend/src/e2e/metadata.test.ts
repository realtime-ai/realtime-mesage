/**
 * End-to-End Tests for Channel Metadata Integration
 *
 * Prerequisites:
 * - Local Redis server running on redis://localhost:6379
 *
 * Run with: REDIS_RUNNING=1 npm test
 * Or skip: npm test (E2E tests will be skipped without Redis)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { createServer, type Server as HTTPServer } from "http";
import type { AddressInfo } from "net";
import Redis from "ioredis";
import { initPresence } from "../presence-server";
import type { PresenceRuntime } from "../presence-server";
import { RealtimeClient } from "../../../realtime-message-sdk/src/core/realtime-client";
import { createMockLogger } from "../test-utils";
import type { ChannelMetadataEvent } from "../../../realtime-message-sdk/src/modules/metadata/types";

const waitFor = async (
  condition: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 50
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Condition not met within timeout");
};

describe.skipIf(!process.env.REDIS_RUNNING)("E2E: Channel Metadata Integration", () => {
  let httpServer: HTTPServer;
  let io: SocketIOServer;
  let redis: Redis;
  let presenceRuntime: PresenceRuntime | null = null;
  let port: number;
  let clients: RealtimeClient[] = [];

  beforeAll(async () => {
    redis = new Redis({
      host: "localhost",
      port: 6379,
      lazyConnect: true,
    });

    try {
      await redis.connect();
      await redis.flushall();
    } catch (error) {
      console.error("Failed to connect to Redis. Make sure Redis is running on localhost:6379");
      throw error;
    }

    httpServer = createServer();
    io = new SocketIOServer(httpServer, {
      cors: { origin: "*" },
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });

    presenceRuntime = await initPresence({
      io,
      redis,
      ttlMs: 5_000,
      reaperIntervalMs: 1_000,
      reaperLookbackMs: 10_000,
      logger: createMockLogger(),
    });
  });

  afterAll(async () => {
    for (const client of clients) {
      await client.shutdown();
    }
    clients = [];

    if (presenceRuntime) {
      await presenceRuntime.dispose();
      presenceRuntime = null;
    }
    await new Promise<void>((resolve, reject) => {
      io.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve) => {
      httpServer.close((err: any) => {
        if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
          console.error("httpServer.close error:", err);
        }
        resolve();
      });
    });
    await redis.quit();
  });

  beforeEach(async () => {
    for (const client of clients) {
      await client.shutdown();
    }
    clients = [];
    await redis.flushall();
  });

  const createClient = (userId: string): RealtimeClient => {
    const client = new RealtimeClient({
      baseUrl: `http://localhost:${port}`,
      authProvider: async () => ({ userId }),
      reconnection: false,
      logger: createMockLogger(),
    });
    clients.push(client);
    return client;
  };

  describe("Complete CRUD Flow", () => {
    it("should complete full CRUD cycle: set -> get -> update -> remove", async () => {
      const client = createClient("user-1");
      await client.connect();

      const { channel } = await client.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      // Set metadata
      const setResponse = await client.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "topic", value: "Initial Topic" },
          { key: "moderator", value: "alice" },
        ],
        options: { addTimestamp: true, addUserId: true },
      });

      expect(setResponse.totalCount).toBe(2);
      expect(setResponse.metadata.topic?.value).toBe("Initial Topic");
      expect(setResponse.metadata.moderator?.value).toBe("alice");
      const initialRevision = setResponse.majorRevision;

      // Get metadata
      const getResponse = await client.metadata.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(getResponse.totalCount).toBe(2);
      expect(getResponse.metadata.topic?.value).toBe("Initial Topic");
      expect(getResponse.majorRevision).toBe(initialRevision);

      // Update metadata
      const updateResponse = await client.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "topic", value: "Updated Topic" },
          { key: "moderator", value: "bob" },
        ],
        options: { majorRevision: initialRevision },
      });

      expect(updateResponse.metadata.topic?.value).toBe("Updated Topic");
      expect(updateResponse.metadata.moderator?.value).toBe("bob");
      expect(updateResponse.majorRevision).toBeGreaterThan(initialRevision);

      // Remove metadata
      const removeResponse = await client.metadata.removeChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "moderator" }],
      });

      expect(removeResponse.totalCount).toBe(1);
      expect(removeResponse.metadata.moderator).toBeUndefined();
      expect(removeResponse.metadata.topic?.value).toBe("Updated Topic");

      await channel.stop();
    });

    it("should maintain data consistency across operations", async () => {
      const client = createClient("user-1");
      await client.connect();

      await client.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      // Set initial state
      const set1 = await client.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "count", value: "0" }],
      });

      // Update multiple times
      for (let i = 1; i <= 5; i++) {
        const prev = await client.metadata.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        });

        await client.metadata.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "count", value: String(i) }],
          options: { majorRevision: prev.majorRevision },
        });
      }

      const final = await client.metadata.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(final.metadata.count?.value).toBe("5");
      expect(final.majorRevision).toBeGreaterThan(set1.majorRevision);
    });
  });

  describe("Multi-Client Scenarios", () => {
    it("should handle concurrent metadata updates with CAS", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");

      await client1.connect();
      await client2.connect();

      await client1.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      // Both clients set initial metadata
      const set1 = await client1.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "value", value: "initial" }],
      });

      // Client 2 tries to update with wrong revision
      await expect(
        client2.metadata.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "value", value: "client2" }],
          options: { majorRevision: set1.majorRevision - 1 },
        })
      ).rejects.toThrow();

      // Client 1 updates successfully
      const update1 = await client1.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "value", value: "client1" }],
        options: { majorRevision: set1.majorRevision },
      });

      expect(update1.metadata.value?.value).toBe("client1");

      // Client 2 now updates with correct revision
      const update2 = await client2.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "value", value: "client2" }],
        options: { majorRevision: update1.majorRevision },
      });

      expect(update2.metadata.value?.value).toBe("client2");
    });

    it("should verify final consistency after concurrent operations", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");
      const client3 = createClient("user-3");

      await Promise.all([
        client1.connect(),
        client2.connect(),
        client3.connect(),
      ]);

      await Promise.all([
        client1.joinRoom({
          roomId: "test-channel",
          userId: "user-1",
          state: {},
        }),
        client2.joinRoom({
          roomId: "test-channel",
          userId: "user-2",
          state: {},
        }),
        client3.joinRoom({
          roomId: "test-channel",
          userId: "user-3",
          state: {},
        }),
      ]);

      // Initial set
      await client1.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "counter", value: "0" }],
      });

      // All clients read
      const [read1, read2, read3] = await Promise.all([
        client1.metadata.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        }),
        client2.metadata.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        }),
        client3.metadata.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        }),
      ]);

      expect(read1.majorRevision).toBe(read2.majorRevision);
      expect(read2.majorRevision).toBe(read3.majorRevision);

      // Sequential updates
      const update1 = await client1.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "counter", value: "1" }],
        options: { majorRevision: read1.majorRevision },
      });

      const update2 = await client2.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "counter", value: "2" }],
        options: { majorRevision: update1.majorRevision },
      });

      const final = await client3.metadata.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(final.metadata.counter?.value).toBe("2");
      expect(final.majorRevision).toBe(update2.majorRevision);
    });
  });

  describe("Event Broadcasting", () => {
    it("should broadcast metadata events to all subscribers", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");

      await client1.connect();
      await client2.connect();

      await client1.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      const events1: ChannelMetadataEvent[] = [];
      const events2: ChannelMetadataEvent[] = [];

      const unsubscribe1 = client1.metadata.onChannelEvent((event) => {
        events1.push(event);
      });

      const unsubscribe2 = client2.metadata.onChannelEvent((event) => {
        events2.push(event);
      });

      // Wait for subscriptions to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 1 updates metadata
      await client1.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated by client1" }],
      });

      await waitFor(() => events1.length > 0 && events2.length > 0);

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
      expect(events1[0].operation).toBe("update");
      expect(events2[0].operation).toBe("update");

      unsubscribe1();
      unsubscribe2();
    });

    it("should include correct event payload structure", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");

      await client1.connect();
      await client2.connect();

      await client1.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = client2.metadata.onChannelEvent((event) => {
        events.push(event);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      await client1.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "topic", value: "Topic" },
          { key: "moderator", value: "alice" },
        ],
        options: { addUserId: true },
      });

      await waitFor(() => events.length > 0);

      const event = events[0];
      expect(event.channelName).toBe("test-channel");
      expect(event.channelType).toBe("MESSAGE");
      expect(event.operation).toBe("set");
      expect(event.items).toHaveLength(2);
      expect(event.majorRevision).toBeGreaterThan(0);
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.authorUid).toBeDefined();

      unsubscribe();
    });

    it("should verify event order", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");

      await client1.connect();
      await client2.connect();

      await client1.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      const events: ChannelMetadataEvent[] = [];

      const unsubscribe = client2.metadata.onChannelEvent((event) => {
        events.push(event);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Perform multiple operations
      await client1.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "step", value: "1" }],
      });

      await waitFor(() => events.length >= 1);

      await client1.metadata.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "step", value: "2" }],
      });

      await waitFor(() => events.length >= 2);

      await client1.metadata.removeChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "step" }],
      });

      await waitFor(() => events.length >= 3);

      expect(events[0].operation).toBe("set");
      expect(events[1].operation).toBe("update");
      expect(events[2].operation).toBe("remove");

      unsubscribe();
    });
  });

  describe("Integration with Presence", () => {
    it("should set metadata after joining presence room", async () => {
      const client = createClient("user-1");
      await client.connect();

      const { channel } = await client.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      const response = await client.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "announcement", value: "Welcome!" }],
      });

      expect(response.channelName).toBe("test-channel");
      expect(response.metadata.announcement?.value).toBe("Welcome!");

      await channel.stop();
    });

    it("should preserve metadata after leaving presence room", async () => {
      const client = createClient("user-1");
      await client.connect();

      const { channel } = await client.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      await client.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "persistent", value: "data" }],
      });

      await channel.stop();

      // Reconnect and verify metadata still exists
      const client2 = createClient("user-2");
      await client2.connect();

      await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      const response = await client2.metadata.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(response.metadata.persistent?.value).toBe("data");
    });

    it("should handle both presence and metadata events", async () => {
      const client1 = createClient("user-1");
      const client2 = createClient("user-2");

      await client1.connect();
      await client2.connect();

      const presenceEvents: any[] = [];
      const metadataEvents: ChannelMetadataEvent[] = [];

      const { channel: channel1 } = await client1.joinRoom({
        roomId: "test-channel",
        userId: "user-1",
        state: {},
      });

      channel1.on("presenceEvent", (event) => {
        presenceEvents.push(event);
      });

      const unsubscribe = client1.metadata.onChannelEvent((event) => {
        metadataEvents.push(event);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const { channel: channel2 } = await client2.joinRoom({
        roomId: "test-channel",
        userId: "user-2",
        state: {},
      });

      await waitFor(() => presenceEvents.length > 0);

      await client2.metadata.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
      });

      await waitFor(() => metadataEvents.length > 0);

      expect(presenceEvents.length).toBeGreaterThan(0);
      expect(metadataEvents.length).toBeGreaterThan(0);

      unsubscribe();
      await channel1.stop();
      await channel2.stop();
    });
  });
});

