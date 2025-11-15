# RTM Web SDK

A lightweight JavaScript SDK for building real-time presence experiences on top of Socket.IO.

## Features

- **Built-in Presence**: Automatic room-based presence with heartbeats and state synchronization
- **Simple API**: Connect, join a room, and start receiving presence events in a few lines
- **TypeScript-First**: Full type safety with reusable contracts shared with the server
- **Flexible Events**: Generic `emit`/`on` helpers with Socket.IO-style acknowledgements
- **Lifecycle Hooks**: Configurable callbacks for connection, disconnection, and reconnection events

## Installation

The SDK sources live in `realtime-message-sdk/src`. Build them with the provided npm script:

```bash
npm run build:sdk
```

The compiled output will be written to `realtime-message-sdk/dist` (by `tsc`). You can then publish it as a package, bundle it into a web app, or import it via relative paths in a monorepo.

## Quick Start

### Basic Presence Usage

```ts
import { RealtimeClient } from "realtime-message-sdk";

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
import { RealtimeClient } from "realtime-message-sdk";

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

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```ts
import type {
  // Core types
  RealtimeClientConfig,
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
} from "realtime-message-sdk";
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
realtime-message-sdk/
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
  demo/
    index.html                 # Interactive browser demo
  tsconfig.json                # TypeScript configuration
```

## Next Steps

- Integrate the SDK build artifacts into your distribution pipeline
- Extend business-specific events directly via Socket.IO (chat, notifications, analytics, etc.)
- Add automated tests (e.g., Vitest + Socket.IO mock server)
- Attach custom server-side Socket.IO handlers alongside `initPresence` to keep presence and app logic aligned
