# Chat Client Module Example

This example demonstrates how to create a custom module for the Realtime Message Client SDK.

## What is a Client Module?

A client module extends the functionality of `RealtimeClient` by:
- Listening to server events
- Providing high-level APIs for specific features
- Managing module-specific state

Modules have access to:
- `context.socket` - The Socket.IO client instance
- `context.logger` - A logger instance
- `context.config` - The client configuration

## Module Interface

```typescript
interface ClientModule {
  name: string;
  onConnected?(context: ClientModuleContext): void | Promise<void>;
  onDisconnected?(): void | Promise<void>;
  onShutdown?(): void | Promise<void>;
}

interface ClientModuleContext {
  socket: Socket;
  logger: Logger;
  config: RealtimeClientConfig;
}
```

## Chat Module Features

This chat module provides:

- `sendMessage()` - Send a message to a room
- `getHistory()` - Retrieve message history
- `onMessage()` - Listen for new messages

## Usage

```typescript
import { RealtimeClient, createPresenceModule } from "rtm-sdk";
import { createChatModule } from "./chat-module";

const client = new RealtimeClient({
  baseUrl: "http://localhost:3000",
});

const presenceModule = createPresenceModule();
const chatModule = createChatModule();

client.use(presenceModule);
client.use(chatModule);

await client.connect();

// Use chat API
await chatModule.api.sendMessage("room1", "Hello!");

chatModule.api.onMessage((msg) => {
  console.log("New message:", msg);
});

const history = await chatModule.api.getHistory("room1", 50);
```

## Key Concepts

1. **No Core Code Changes** - Works entirely through the module system
2. **Direct Socket Access** - `context.socket` provides full Socket.IO API
3. **Separation of Concerns** - All chat logic is in this module
4. **Reusable** - Can be packaged as a separate npm module
