# Custom Chat Module Example

This example demonstrates how to create a custom module for the Realtime Message server.

## What is a Module?

A module is a self-contained unit of functionality that can be plugged into the Realtime Message server. Modules have access to:

- `context.io` - The Socket.IO server instance
- `context.redis` - The Redis client instance
- `context.logger` - A logger instance

## Module Interface

```typescript
interface RealtimeModule {
  name: string;
  register(context: ModuleContext): void | Promise<void>;
  onConnection?(socket: Socket, context: ModuleContext): void;
  onShutdown?(): void | Promise<void>;
}
```

## Chat Module Features

This example chat module provides:

- `chat:send` - Send a message to a room
- `chat:history` - Retrieve message history for a room
- Automatic message persistence in Redis (sorted by timestamp)
- Configurable history limit

## Usage

```typescript
import { RealtimeServer } from "realtime-mesage";
import { createChatModule } from "./chat-module";

const server = new RealtimeServer({ io, redis });

// Register the chat module
server.use(createChatModule({
  maxHistory: 100 // Keep last 100 messages per room
}));

await server.start();
```

## Client Usage

```javascript
// Send a message
socket.emit("chat:send", {
  roomId: "room1",
  message: "Hello, world!"
}, (response) => {
  console.log("Message sent:", response.msgId);
});

// Get message history
socket.emit("chat:history", {
  roomId: "room1",
  limit: 50
}, (response) => {
  console.log("Messages:", response.messages);
});

// Listen for new messages
socket.on("chat:message", (msg) => {
  console.log("New message:", msg);
});
```

## Key Concepts

1. **No Core Code Changes** - This module works entirely through the module system, without modifying the core server code.

2. **Direct Access** - Modules have direct access to Socket.IO and Redis APIs, no abstraction layers.

3. **Business Logic Separation** - All chat-specific logic is contained within this module.

4. **Reusable** - This module can be packaged as a separate npm package and reused across projects.
