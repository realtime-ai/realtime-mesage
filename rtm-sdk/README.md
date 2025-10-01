# RTM Web SDK

A lightweight, modular JavaScript SDK for building real-time messaging applications. Built on Socket.IO with built-in presence support and extensible module architecture.

## Features

- **Built-in Presence**: Automatic room-based presence with heartbeats and state synchronization
- **Simple API**: No module registration needed for basic presence - works out of the box
- **TypeScript-First**: Full type safety with reusable contracts shared with the server
- **Extensible**: Add custom modules for domain-specific features (chat, notifications, etc.)
- **Flexible Events**: Generic `emit`/`on` helpers with Socket.IO-style acknowledgements
- **Lifecycle Hooks**: Configurable callbacks for connection, disconnection, and reconnection events

## Installation

The SDK sources live in `rtm-sdk/src`. Build them with the provided npm script:

```bash
npm run build:sdk
```

The compiled output will be written to `rtm-sdk/dist` (by `tsc`). You can then publish it as a package, bundle it into a web app, or import it via relative paths in a monorepo.

## Quick Start

### Basic Presence Usage

```ts
import { RealtimeClient } from "rtm-sdk";

// Create and connect client
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: () => ({ token: localStorage.getItem("authToken") ?? "" }),
});

await client.connect();

// Join a room with presence (built-in API)
const { channel, response } = await client.joinRoom({
  roomId: "room-42",
  userId: "user-123",
  state: { mic: true, camera: false },
});

if (!response.ok) {
  console.error("Failed to join:", response.error);
  return;
}

// Listen for presence events
channel.on("presenceEvent", (event) => {
  console.log(`${event.type}: ${event.userId}`, event.state);
});

channel.on("snapshot", (snapshot) => {
  console.log("Current room members:", snapshot);
});

// Update your presence state
await channel.updateState({ typing: true });

// Leave the room
await channel.leave();

// Disconnect when done
await client.disconnect();
```

## Core API

### RealtimeClient

The main client manages Socket.IO connection lifecycle and provides built-in presence API.

```ts
import { RealtimeClient } from "rtm-sdk";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",

  // Optional: Auth headers added to Socket.IO handshake
  authProvider: async () => {
    const token = await fetchAuthToken();
    return { Authorization: `Bearer ${token}` };
  },

  // Optional: Default presence configuration
  presence: {
    heartbeatIntervalMs: 10000,        // Default: 10s
    heartbeatAckTimeoutMs: 8000,       // Default: 80% of interval
    maxMissedHeartbeats: 2,            // Default: 2
    presenceEventName: "presence:event", // Default: "presence:event"
  },

  // Optional: Custom logger
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },

  // Optional: Connection settings
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelayMax: 5000,
});

// Connect to server
await client.connect();

// Check connection status
if (client.isConnected()) {
  console.log("Connected!");
}

// Disconnect
await client.disconnect();
```

### Built-in Presence API

#### `client.joinRoom(params, options?)`

Join a room with presence (convenience method that creates a channel and joins automatically).

```ts
const { channel, response } = await client.joinRoom(
  {
    roomId: "room-123",
    userId: "user-456",
    state: { status: "online", avatar: "https://..." },
  },
  {
    heartbeatIntervalMs: 5000, // Optional: Override default
  }
);

if (response.ok) {
  console.log("Joined successfully", response.self.connId);
} else {
  console.error("Join failed:", response.error);
}
```

#### `client.createPresenceChannel(options?)`

Create a presence channel with custom options (for more control).

```ts
const channel = client.createPresenceChannel({
  heartbeatIntervalMs: 15000,
  maxMissedHeartbeats: 3,
});

const response = await channel.join({
  roomId: "room-123",
  userId: "user-456",
  state: { mic: true },
});
```

## Presence Channel

### Events

```ts
// Connected to room
channel.on("connected", ({ connId }) => {
  console.log("Joined room with connection:", connId);
});

// Initial snapshot of room members
channel.on("snapshot", (members) => {
  members.forEach(member => {
    console.log(member.userId, member.state);
  });
});

// Real-time presence updates
channel.on("presenceEvent", (event) => {
  switch (event.type) {
    case "join":
      console.log(`${event.userId} joined`, event.state);
      break;
    case "leave":
      console.log(`${event.userId} left`);
      break;
    case "update":
      console.log(`${event.userId} updated state`, event.state);
      break;
  }
});

// Heartbeat acknowledgements
channel.on("heartbeatAck", (response) => {
  if (response.ok) {
    console.log("Heartbeat acknowledged");
  }
});

// Errors
channel.on("error", (error) => {
  console.error("Channel error:", error);
});
```

### Methods

```ts
// Update presence state (triggers heartbeat)
await channel.updateState({ typing: true, cursor: { x: 100, y: 200 } });

// Send manual heartbeat
await channel.sendHeartbeat({ patchState: { online: true } });

// Leave room (stops heartbeats)
await channel.leave();

// Stop channel (leave + cleanup)
await channel.stop();
```

## Custom Messaging

### Using Presence Channel for Custom Events

Presence channels support custom events for application-specific messaging:

```ts
// Listen for custom events
const unsubscribe = channel.on("chat:message", (message) => {
  console.log("Received chat message:", message);
});

// Emit custom event (fire-and-forget)
channel.emit("chat:message", { text: "Hello world" });

// Emit with callback acknowledgement
channel.emit("chat:typing", { userId: "user-123" }, (response) => {
  console.log("Server acknowledged:", response);
});

// Emit with promise-based acknowledgement
const response = await channel.emit<{ success: boolean }>(
  "chat:reaction",
  { emoji: "👍", messageId: "msg-456" },
  { ack: true, timeoutMs: 5000 }
);

// Cleanup
unsubscribe();
```

### Direct Socket.IO Access

For advanced use cases, access the Socket.IO socket directly:

```ts
await client.connect();
const socket = client.getSocket();

// Listen for custom events
socket.on("notification:new", (payload) => {
  console.log("New notification:", payload);
});

// Emit custom events with acknowledgement
socket.emit("analytics:track", { event: "page_view" }, (response) => {
  console.log("Tracked:", response);
});

// Request-response pattern
socket.emit("user:profile", { userId: "123" }, (profile) => {
  console.log("User profile:", profile);
});
```

## Creating Custom Modules

You can create custom modules for domain-specific features like chat, notifications, or analytics.

### Example: Chat Module

```ts
import type { ClientModule, ClientModuleContext } from "rtm-sdk";

export interface ChatMessage {
  msgId: string;
  roomId: string;
  userId: string;
  message: string;
  ts: number;
}

export interface ChatModuleAPI {
  sendMessage(roomId: string, message: string): Promise<{ msgId: string }>;
  onMessage(handler: (msg: ChatMessage) => void): () => void;
  loadHistory(roomId: string, limit?: number): Promise<ChatMessage[]>;
}

export function createChatModule(): ClientModule & { api: ChatModuleAPI } {
  let context: ClientModuleContext | null = null;
  const messageHandlers = new Set<(msg: ChatMessage) => void>();

  const api: ChatModuleAPI = {
    async sendMessage(roomId: string, message: string): Promise<{ msgId: string }> {
      if (!context) throw new Error("Chat module not initialized");

      return new Promise((resolve, reject) => {
        context.socket.emit(
          "chat:send",
          { roomId, message },
          (response: { ok: boolean; msgId?: string; error?: string }) => {
            if (response.ok && response.msgId) {
              resolve({ msgId: response.msgId });
            } else {
              reject(new Error(response.error || "Failed to send message"));
            }
          }
        );
      });
    },

    onMessage(handler: (msg: ChatMessage) => void): () => void {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    async loadHistory(roomId: string, limit = 50): Promise<ChatMessage[]> {
      if (!context) throw new Error("Chat module not initialized");

      return new Promise((resolve, reject) => {
        context.socket.emit(
          "chat:history",
          { roomId, limit },
          (response: { ok: boolean; messages?: ChatMessage[]; error?: string }) => {
            if (response.ok && response.messages) {
              resolve(response.messages);
            } else {
              reject(new Error(response.error || "Failed to load history"));
            }
          }
        );
      });
    },
  };

  return {
    name: "chat",
    api,

    onConnected(ctx: ClientModuleContext): void {
      context = ctx;
      ctx.logger.info("Chat module connected");

      ctx.socket.on("chat:message", (msg: ChatMessage) => {
        messageHandlers.forEach(handler => handler(msg));
      });
    },

    onDisconnected(): void {
      context = null;
    },

    onShutdown(): void {
      messageHandlers.clear();
    },
  };
}
```

### Usage

```ts
import { RealtimeClient } from "rtm-sdk";
import { createChatModule } from "./chat-module";

const client = new RealtimeClient({ baseUrl: "https://rtm.yourdomain.com" });

// Register custom chat module
const chatModule = createChatModule();
client.use(chatModule);

await client.connect();

// Listen for messages
const unsubscribe = chatModule.api.onMessage((msg) => {
  console.log(`${msg.userId}: ${msg.message}`);
});

// Send message
const { msgId } = await chatModule.api.sendMessage("room-123", "Hello!");

// Load history
const history = await chatModule.api.loadHistory("room-123", 100);
```

## Complete Example: Presence + Custom Messaging

```ts
import { RealtimeClient } from "rtm-sdk";

// Setup client with presence defaults
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: () => ({ token: getAuthToken() }),
  presence: {
    heartbeatIntervalMs: 5000, // Send heartbeats every 5s
  },
});

// Connect
await client.connect();

// Join room with presence
const { channel } = await client.joinRoom({
  roomId: "collab-room-42",
  userId: "user-123",
  state: { cursor: null, selection: null },
});

// Track presence
channel.on("presenceEvent", (event) => {
  if (event.type === "join") {
    addUserToUI(event.userId, event.state);
  } else if (event.type === "leave") {
    removeUserFromUI(event.userId);
  } else if (event.type === "update") {
    updateUserInUI(event.userId, event.state);
  }
});

// Update presence on user action
document.addEventListener("mousemove", async (e) => {
  await channel.updateState({ cursor: { x: e.clientX, y: e.clientY } });
});

// Custom messaging: Send chat messages
channel.on("chat:message", ({ userId, text, ts }) => {
  appendMessageToChat(userId, text, ts);
});

channel.emit("chat:message", {
  text: "Hello everyone!",
  ts: Date.now()
});

// Custom messaging: Reactions
channel.on("reaction:add", ({ userId, emoji, targetId }) => {
  addReactionToElement(targetId, emoji, userId);
});

const ackResponse = await channel.emit(
  "reaction:add",
  { emoji: "👍", targetId: "msg-456" },
  { ack: true, timeoutMs: 3000 }
);

if (ackResponse.ok) {
  console.log("Reaction added successfully");
}

// Cleanup
await channel.leave();
await client.disconnect();
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```ts
import type {
  // Core types
  RealtimeClientConfig,
  ClientModule,
  ClientModuleContext,
  Logger,

  // Presence types
  PresenceChannel,
  PresenceChannelOptions,
  PresenceJoinParams,
  PresenceJoinResponse,
  PresenceHeartbeatResponse,
  PresenceEventEnvelope,
  ConnectionStateSnapshot,
  PresenceStatePatch,
  PresenceChannelEventMap,
  CustomEmitOptions,
} from "rtm-sdk";
```

## Advanced Patterns

### Multiple Presence Channels

```ts
await client.connect();

// Join multiple rooms simultaneously
const { channel: workspaceChannel } = await client.joinRoom({
  roomId: "workspace-1",
  userId: "user-123",
  state: { status: "online" },
});

const { channel: documentChannel } = await client.joinRoom({
  roomId: "document-456",
  userId: "user-123",
  state: { cursor: null, selection: null },
});

// Each channel has independent lifecycle and state
workspaceChannel.on("presenceEvent", handleWorkspacePresence);
documentChannel.on("presenceEvent", handleDocumentPresence);
```

### Auth Token Refresh

```ts
let authToken = "";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  authProvider: async () => {
    // Refresh token if needed
    if (isTokenExpired(authToken)) {
      authToken = await refreshAuthToken();
    }
    return { Authorization: `Bearer ${authToken}` };
  },
});
```

### Custom Logger Integration

```ts
import { createLogger } from "./my-logger";

const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  logger: createLogger({
    level: "debug",
    prefix: "[RTM]"
  }),
});
```

### Override Presence Defaults Per Channel

```ts
const client = new RealtimeClient({
  baseUrl: "https://rtm.yourdomain.com",
  presence: {
    heartbeatIntervalMs: 10000, // Global default
  },
});

await client.connect();

// Use default settings
const { channel: channel1 } = await client.joinRoom({
  roomId: "room-1",
  userId: "user-123",
});

// Override for specific channel
const { channel: channel2 } = await client.joinRoom(
  {
    roomId: "room-2",
    userId: "user-123",
  },
  {
    heartbeatIntervalMs: 3000, // Send more frequent heartbeats
  }
);
```

## Interactive Demo

Start the local server and open the interactive demo:

```bash
npm run dev              # Start server
npm run build:sdk        # Build SDK
npm run sdk:demo         # Open demo at http://localhost:4173
```

The demo allows you to:
- Connect to the RTM server
- Join rooms with presence
- Send heartbeats and state updates
- Inspect real-time presence events
- Test custom events

## Project Structure

```
rtm-sdk/
  src/
    core/
      realtime-client.ts       # Core client with built-in presence API
      types.ts                 # Core interfaces and types
      event-emitter.ts         # Event emitter base class
    modules/
      presence/
        presence-channel.ts    # Presence channel implementation
        types.ts               # Presence types
    index.ts                   # Main SDK exports
  examples/
    chat-client-module/        # Example chat module implementation
  demo/
    index.html                 # Interactive browser demo
  tsconfig.json                # TypeScript configuration
```

## Next Steps

- Integrate the SDK build artifacts into your distribution pipeline
- Create custom modules for your domain-specific features (chat, notifications, analytics, etc.)
- Add automated tests (e.g., Vitest + Socket.IO mock server)
- Explore the [server-side module system](../README.md) for building corresponding server features
