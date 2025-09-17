# RTM Web SDK

A lightweight, modular JavaScript SDK for interacting with the realtime presence service from the browser. It wraps the Socket.IO protocol and handles epochs, heartbeats, and presence event fan-out so product teams can focus on application-specific behavior.

## Features

- Simple `RealtimeMessageClient` that encapsulates transport setup and reconnect options
- Room-level `PresenceChannel` with automatic heartbeat scheduling and event emitter semantics
- TypeScript-first API with reusable types shared with the server contracts
- Pluggable auth headers and configurable heartbeat cadence
- Generic custom event helpers to emit app-specific messages or subscribe to server fan-out

## Installation

The SDK sources live in `rtm-sdk/src`. Build them with the provided npm script:

```bash
npm run build:sdk
```

The compiled output will be written to `rtm-sdk/dist` (by `tsc`). You can then publish it as a package, bundle it into a web app, or import it via relative paths in a monorepo.

## Interactive Demo

Ship a local presence server (e.g. `npm run dev`) and then open the SDK demo to exercise the client end-to-end:

```bash
npm run build:sdk
npm run sdk:demo
```

The script serves `rtm-sdk/demo/index.html` on <http://localhost:4173>. Fill in the base URL, room ID and user ID to join, send heartbeats/state patches, and inspect incoming presence events.

## Usage Example

```ts
import { RealtimeMessageClient } from "rtm-sdk";

const client = new RealtimeMessageClient({
  baseUrl: "https://presence.yourdomain.com",
  authProvider: () => ({ token: window.localStorage.getItem("authToken") ?? "" }),
});

const { channel, response } = await client.joinRoom({
  roomId: "room-42",
  userId: "user-123",
  state: { mic: true },
});

channel.on("presenceEvent", (event) => {
  console.log("presence update", event);
});

channel.on("error", (error) => {
  console.error("presence error", error);
});

// Update presence state
await client.sendHeartbeat(channel, { typing: true });

// Send a custom application event (with acknowledgement)
const ack = await client.sendCustomMessage(
  channel,
  "chat:message",
  { text: "Hello world" },
  { ack: true }
);
console.log("server ack", ack);

// Listen for custom events broadcast by the server
const unsubscribe = channel.onCustomEvent("chat:message", (payload) => {
  console.log("custom event", payload);
});

// Note: sendCustomMessage mirrors Socket.IO emit semantics — provide a callback or
// pass `{ ack: true }` to await an acknowledgement.

// Later…
await channel.leave();
await client.shutdown();
```

## Project Layout

```
rtm-sdk/
  src/
    client.ts                 # Entry point for consumers
    presence/presence-channel.ts
    transport/socket-transport.ts
    utils/event-emitter.ts
    types.ts
  tsconfig.json               # Standalone build configuration
  README.md
```

## Next Steps

- Integrate the SDK build artifacts into your distribution pipeline
- Extend the SDK with additional domain modules (chat, reactions, etc.) as needed
- Add automated tests (e.g., Vitest + Socket.IO mock server) to guard future changes
