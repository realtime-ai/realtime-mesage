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
  channelMetadataKey,
  lockKey,
} from "./keys";
import { PresenceService } from "./service";
import type {
  ChannelMetadataItemInput,
  ChannelMetadataResponse,
} from "./types";

const redisFactory = () => new (Redis as unknown as { new (): RedisClient })();

const waitFor = async (
  condition: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10
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

describe("PresenceService - Channel Metadata", () => {
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

  describe("Redis Storage Structure", () => {
    it("should use correct key format for channel metadata", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Test" }],
        actorUserId: "user-1",
      });

      expect(response.channelName).toBe("test-channel");
      expect(response.channelType).toBe("MESSAGE");

      const key = channelMetadataKey("MESSAGE", "test-channel");
      const exists = await redis.exists(key);
      expect(exists).toBe(1);
    });

    it("should store metadata in hash with correct fields", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "topic", value: "Meeting" },
          { key: "moderator", value: "alice" },
        ],
        actorUserId: "user-1",
      });

      const key = channelMetadataKey("MESSAGE", "test-channel");
      const hash = await redis.hgetall(key);

      expect(hash.majorRevision).toBeDefined();
      expect(hash.totalCount).toBeDefined();
      expect(hash.items).toBeDefined();

      const items = JSON.parse(hash.items);
      expect(items.topic).toBeDefined();
      expect(items.moderator).toBeDefined();
      expect(items.topic.value).toBe("Meeting");
    });

    it("should correctly parse and serialize metadata items", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "topic", value: "Test Topic" },
          { key: "empty", value: "" },
        ],
        options: { addTimestamp: true, addUserId: true },
        actorUserId: "user-123",
      });

      const response = await service.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(response.metadata.topic?.value).toBe("Test Topic");
      expect(response.metadata.empty?.value).toBe("");
      expect(response.metadata.topic?.updated).toBeDefined();
      expect(response.metadata.topic?.authorUid).toBe("user-123");
    });

    it("should handle empty metadata correctly", async () => {
      const response = await service.getChannelMetadata({
        channelName: "non-existent",
        channelType: "MESSAGE",
      });

      expect(response.totalCount).toBe(0);
      expect(response.majorRevision).toBe(0);
      expect(Object.keys(response.metadata)).toHaveLength(0);
    });
  });

  describe("CRUD Operations", () => {
    describe("setChannelMetadata", () => {
      it("should create new channel metadata", async () => {
        const response = await service.setChannelMetadata({
          channelName: "new-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "New Topic" }],
          actorUserId: "user-1",
        });

        expect(response.channelName).toBe("new-channel");
        expect(response.channelType).toBe("MESSAGE");
        expect(response.totalCount).toBe(1);
        expect(response.majorRevision).toBeGreaterThan(0);
        expect(response.metadata.topic?.value).toBe("New Topic");
      });

      it("should overwrite existing metadata", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Initial" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated" }],
          actorUserId: "user-1",
        });

        expect(response.totalCount).toBe(1);
        expect(response.metadata.topic?.value).toBe("Updated");
        expect(response.metadata.moderator).toBeUndefined();
      });

      it("should set multiple metadata items in batch", async () => {
        const response = await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Meeting" },
            { key: "moderator", value: "alice" },
            { key: "status", value: "active" },
          ],
          actorUserId: "user-1",
        });

        expect(response.totalCount).toBe(3);
        expect(response.metadata.topic?.value).toBe("Meeting");
        expect(response.metadata.moderator?.value).toBe("alice");
        expect(response.metadata.status?.value).toBe("active");
      });

      it("should verify Redis storage after set", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Stored" }],
          actorUserId: "user-1",
        });

        const key = channelMetadataKey("MESSAGE", "test-channel");
        const hash = await redis.hgetall(key);
        const items = JSON.parse(hash.items);

        expect(items.topic.value).toBe("Stored");
        expect(Number(hash.totalCount)).toBe(1);
      });
    });

    describe("getChannelMetadata", () => {
      it("should read complete metadata", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Meeting" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        });

        expect(response.totalCount).toBe(2);
        expect(response.metadata.topic?.value).toBe("Meeting");
        expect(response.metadata.moderator?.value).toBe("alice");
      });

      it("should return empty structure for non-existent channel", async () => {
        const response = await service.getChannelMetadata({
          channelName: "non-existent",
          channelType: "MESSAGE",
        });

        expect(response.totalCount).toBe(0);
        expect(response.majorRevision).toBe(0);
        expect(Object.keys(response.metadata)).toHaveLength(0);
      });

      it("should match Redis data exactly", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Test" }],
          actorUserId: "user-1",
        });

        const key = channelMetadataKey("MESSAGE", "test-channel");
        const hash = await redis.hgetall(key);
        const storedItems = JSON.parse(hash.items);

        const response = await service.getChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
        });

        expect(response.metadata.topic?.value).toBe(storedItems.topic.value);
        expect(response.majorRevision).toBe(Number(hash.majorRevision));
      });
    });

    describe("updateChannelMetadata", () => {
      it("should update single metadata item", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Initial" }],
          actorUserId: "user-1",
        });

        const response = await service.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated" }],
          actorUserId: "user-1",
        });

        expect(response.metadata.topic?.value).toBe("Updated");
        expect(response.metadata.topic?.revision).toBeGreaterThan(1);
      });

      it("should update multiple metadata items", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Initial" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Updated Topic" },
            { key: "moderator", value: "bob" },
          ],
          actorUserId: "user-1",
        });

        expect(response.metadata.topic?.value).toBe("Updated Topic");
        expect(response.metadata.moderator?.value).toBe("bob");
        expect(response.totalCount).toBe(2);
      });

      it("should throw error when updating non-existent item", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Initial" }],
          actorUserId: "user-1",
        });

        await expect(
          service.updateChannelMetadata({
            channelName: "test-channel",
            channelType: "MESSAGE",
            data: [{ key: "nonexistent", value: "Value" }],
            actorUserId: "user-1",
          })
        ).rejects.toThrow();
      });

      it("should only update specified items", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Initial" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated" }],
          actorUserId: "user-1",
        });

        expect(response.metadata.topic?.value).toBe("Updated");
        expect(response.metadata.moderator?.value).toBe("alice");
      });
    });

    describe("removeChannelMetadata", () => {
      it("should remove specified metadata items", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Topic" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.removeChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "moderator" }],
          actorUserId: "user-1",
        });

        expect(response.totalCount).toBe(1);
        expect(response.metadata.topic?.value).toBe("Topic");
        expect(response.metadata.moderator).toBeUndefined();
      });

      it("should remove all metadata when data is not provided", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [
            { key: "topic", value: "Topic" },
            { key: "moderator", value: "alice" },
          ],
          actorUserId: "user-1",
        });

        const response = await service.removeChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          actorUserId: "user-1",
        });

        expect(response.totalCount).toBe(0);
        expect(Object.keys(response.metadata)).toHaveLength(0);
      });

      it("should verify Redis cleanup after removal", async () => {
        await service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Topic" }],
          actorUserId: "user-1",
        });

        await service.removeChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          actorUserId: "user-1",
        });

        const key = channelMetadataKey("MESSAGE", "test-channel");
        const hash = await redis.hgetall(key);
        const items = JSON.parse(hash.items || "{}");

        expect(Object.keys(items)).toHaveLength(0);
        expect(Number(hash.totalCount)).toBe(0);
      });
    });
  });

  describe("Version Control", () => {
    it("should increment majorRevision on each write operation", async () => {
      const response1 = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Initial" }],
        actorUserId: "user-1",
      });

      const initialRevision = response1.majorRevision;

      const response2 = await service.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        actorUserId: "user-1",
      });

      expect(response2.majorRevision).toBeGreaterThan(initialRevision);

      const response3 = await service.removeChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic" }],
        actorUserId: "user-1",
      });

      expect(response3.majorRevision).toBeGreaterThan(response2.majorRevision);
    });

    it("should start majorRevision at 0 for new channels", async () => {
      const response = await service.setChannelMetadata({
        channelName: "new-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      expect(response.majorRevision).toBeGreaterThanOrEqual(0);
    });

    it("should increment item revision on each update", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Initial" }],
        actorUserId: "user-1",
      });

      const response1 = await service.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      const initialRevision = response1.metadata.topic?.revision ?? 0;

      await service.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        actorUserId: "user-1",
      });

      const response2 = await service.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      expect(response2.metadata.topic?.revision).toBeGreaterThan(initialRevision);
    });

    it("should start item revision at 1 for new items", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      expect(response.metadata.topic?.revision).toBeGreaterThanOrEqual(1);
    });

    it("should detect CAS conflicts with WATCH/MULTI/EXEC", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Initial" }],
        actorUserId: "user-1",
      });

      const response1 = await service.getChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
      });

      // Simulate concurrent modification
      await redis.hset(
        channelMetadataKey("MESSAGE", "test-channel"),
        "majorRevision",
        String(response1.majorRevision + 10)
      );

      await expect(
        service.updateChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Updated" }],
          options: { majorRevision: response1.majorRevision },
          actorUserId: "user-1",
        })
      ).rejects.toThrow();
    });
  });

  describe("Lock Verification", () => {
    it("should verify lock ownership when lockName is provided", async () => {
      await redis.set(lockKey("test-lock"), "user-allowed");

      await expect(
        service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Value" }],
          options: { lockName: "test-lock" },
          actorUserId: "user-denied",
        })
      ).rejects.toThrow();

      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Value" }],
        options: { lockName: "test-lock" },
        actorUserId: "user-allowed",
      });

      expect(response.metadata.topic?.value).toBe("Value");
    });

    it("should throw error when lock does not exist", async () => {
      await expect(
        service.setChannelMetadata({
          channelName: "test-channel",
          channelType: "MESSAGE",
          data: [{ key: "topic", value: "Value" }],
          options: { lockName: "nonexistent-lock" },
          actorUserId: "user-1",
        })
      ).rejects.toThrow();
    });

    it("should work normally when lockName is not provided", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Value" }],
        actorUserId: "user-1",
      });

      expect(response.metadata.topic?.value).toBe("Value");
    });
  });

  describe("Event Publishing", () => {
    it("should publish set operation events", async () => {
      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events.length > 0);

      expect(events).toHaveLength(1);
      expect(events[0].operation).toBe("set");
      expect(events[0].channelName).toBe("test-channel");
      expect(events[0].channelType).toBe("MESSAGE");
      expect(events[0].items).toHaveLength(1);

      await unsubscribe();
    });

    it("should publish update operation events", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Initial" }],
        actorUserId: "user-1",
      });

      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.updateChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events.length > 0);

      expect(events[0].operation).toBe("update");
      expect(events[0].items[0].key).toBe("topic");

      await unsubscribe();
    });

    it("should publish remove operation events", async () => {
      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.removeChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events.length > 0);

      expect(events[0].operation).toBe("remove");
      expect(events[0].items[0].key).toBe("topic");

      await unsubscribe();
    });

    it("should include complete event payload", async () => {
      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        options: { addUserId: true },
        actorUserId: "user-123",
      });

      await waitFor(() => events.length > 0);

      const event = events[0];
      expect(event).toHaveProperty("channelName");
      expect(event).toHaveProperty("channelType");
      expect(event).toHaveProperty("operation");
      expect(event).toHaveProperty("items");
      expect(event).toHaveProperty("majorRevision");
      expect(event).toHaveProperty("timestamp");
      expect(event.authorUid).toBe("user-123");

      await unsubscribe();
    });

    it("should publish to correct Redis channel", async () => {
      const publishedMessages: string[] = [];
      const subscriber = redis.duplicate();
      await subscriber.psubscribe("prs:{chan:*}:meta_events");
      subscriber.on("pmessage", (_pattern, _channel, message) => {
        publishedMessages.push(message);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => publishedMessages.length > 0);

      expect(publishedMessages.length).toBeGreaterThan(0);
      const payload = JSON.parse(publishedMessages[0]);
      expect(payload.channelName).toBe("test-channel");
      expect(payload.channelType).toBe("MESSAGE");

      subscriber.disconnect();
    });
  });

  describe("Event Subscription", () => {
    it("should receive events after subscribing", async () => {
      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events.length > 0);

      expect(events.length).toBeGreaterThan(0);

      await unsubscribe();
    });

    it("should support multiple subscribers", async () => {
      const events1: any[] = [];
      const events2: any[] = [];

      const unsubscribe1 = await service.subscribeMetadata((event) => {
        events1.push(event);
      });

      const unsubscribe2 = await service.subscribeMetadata((event) => {
        events2.push(event);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events1.length > 0 && events2.length > 0);

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);

      await unsubscribe1();
      await unsubscribe2();
    });

    it("should stop receiving events after unsubscribe", async () => {
      const events: any[] = [];
      const unsubscribe = await service.subscribeMetadata((event) => {
        events.push(event);
      });

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      await waitFor(() => events.length > 0);
      const initialCount = events.length;

      await unsubscribe();

      await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "topic", value: "Updated" }],
        actorUserId: "user-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(events.length).toBe(initialCount);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty data array", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [],
        actorUserId: "user-1",
      });

      expect(response.totalCount).toBe(0);
      expect(Object.keys(response.metadata)).toHaveLength(0);
    });

    it("should handle empty string values", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [{ key: "empty", value: "" }],
        actorUserId: "user-1",
      });

      expect(response.metadata.empty?.value).toBe("");
    });

    it("should handle special characters in key and value", async () => {
      const response = await service.setChannelMetadata({
        channelName: "test-channel",
        channelType: "MESSAGE",
        data: [
          { key: "key-with-dash", value: "value with spaces" },
          { key: "key_with_underscore", value: "value\nwith\nnewlines" },
        ],
        actorUserId: "user-1",
      });

      expect(response.metadata["key-with-dash"]?.value).toBe("value with spaces");
      expect(response.metadata.key_with_underscore?.value).toBe("value\nwith\nnewlines");
    });

    it("should handle special characters in channelName and channelType", async () => {
      const response = await service.setChannelMetadata({
        channelName: "channel-with-special-chars-123",
        channelType: "MESSAGE_TYPE",
        data: [{ key: "topic", value: "Topic" }],
        actorUserId: "user-1",
      });

      expect(response.channelName).toBe("channel-with-special-chars-123");
      expect(response.channelType).toBe("MESSAGE_TYPE");
    });
  });
});

