import { RealtimeMessageClient } from "../dist/index.js";

const joinForm = document.getElementById("join-form");
const baseUrlInput = document.getElementById("base-url");
const roomIdInput = document.getElementById("room-id");
const userIdInput = document.getElementById("user-id");
const initialStateInput = document.getElementById("initial-state");
const patchStateInput = document.getElementById("patch-state");
const heartbeatBtn = document.getElementById("heartbeat-btn");
const patchBtn = document.getElementById("patch-btn");
const leaveBtn = document.getElementById("leave-btn");
const patchSection = document.querySelector(".patch-input");
const customBtn = document.getElementById("custom-btn");
const customEventInput = document.getElementById("custom-event");
const customPayloadInput = document.getElementById("custom-payload");
const customSection = document.querySelector(".custom-input");
const eventLog = document.getElementById("event-log");

let client = null;
let activeChannel = null;
let unsubscribeHandlers = [];
let clientHookCleanups = [];

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const baseUrl = baseUrlInput.value.trim();
  const roomId = roomIdInput.value.trim();
  const userId = userIdInput.value.trim();
  const stateRaw = initialStateInput.value.trim();

  if (!baseUrl || !roomId || !userId) {
    log("warn", "Please provide base URL, room ID and user ID.");
    return;
  }

  let parsedState = undefined;
  if (stateRaw) {
    try {
      parsedState = JSON.parse(stateRaw);
    } catch (error) {
      log("error", `Initial state JSON is invalid: ${error.message}`);
      return;
    }
  }

  disableJoinForm(true);
  await disposeCurrentChannel();

  try {
    client = new RealtimeMessageClient({ baseUrl });
    registerClientHooks(client);
    const { channel, response } = await client.joinRoom({
      roomId,
      userId,
      state: parsedState ?? undefined,
    });

    activeChannel = channel;
    log("info", `Joined room ${roomId} as ${userId}`);
    log("event", response);
    attachChannelHandlers(channel);
    updateControls();
  } catch (error) {
    log("error", `Failed to join: ${error instanceof Error ? error.message : String(error)}`);
    await disposeCurrentChannel();
  } finally {
    disableJoinForm(false);
  }
});

heartbeatBtn.addEventListener("click", async () => {
  if (!activeChannel || !client) {
    return;
  }
  heartbeatBtn.disabled = true;
  try {
    const ack = await client.sendHeartbeat(activeChannel);
    log("event", { heartbeatAck: ack });
  } catch (error) {
    log("error", `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    heartbeatBtn.disabled = false;
  }
});

patchBtn.addEventListener("click", async () => {
  if (!activeChannel || !client) {
    return;
  }

  let patchPayload;
  const rawPatch = patchStateInput.value.trim();
  if (!rawPatch) {
    log("warn", "Patch state is empty.");
    return;
  }

  try {
    patchPayload = JSON.parse(rawPatch);
  } catch (error) {
    log("error", `Patch JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  patchBtn.disabled = true;
  try {
    const ack = await client.sendHeartbeat(activeChannel, patchPayload);
    log("event", { heartbeatAck: ack, patch: patchPayload });
  } catch (error) {
    log("error", `Patch failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    patchBtn.disabled = false;
  }
});

customBtn.addEventListener("click", async () => {
  if (!activeChannel || !client) {
    return;
  }

  const eventName = customEventInput.value.trim();
  if (!eventName) {
    log("warn", "Custom event name is required.");
    return;
  }

  const rawPayload = customPayloadInput.value.trim();
  let payload = undefined;
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch (_error) {
      payload = rawPayload;
    }
  }

  customBtn.disabled = true;
  try {
    const ack = await client.emit(activeChannel, eventName, payload, {
      ack: true,
    });
    log("event", { customAck: ack, event: eventName, payload });
  } catch (error) {
    log("error", `Custom event failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    customBtn.disabled = false;
  }
});

leaveBtn.addEventListener("click", async () => {
  await disposeCurrentChannel(true);
  log("info", "Left room");
});

async function disposeCurrentChannel(shouldShutdownClient = false) {
  cleanupClientHooks();
  if (unsubscribeHandlers.length > 0) {
    unsubscribeHandlers.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.error("Failed to remove event handler", error);
      }
    });
    unsubscribeHandlers = [];
  }

  if (activeChannel) {
    try {
      await activeChannel.stop();
    } catch (error) {
      log("error", `Error while stopping channel: ${error instanceof Error ? error.message : String(error)}`);
    }
    activeChannel = null;
  }

  if (shouldShutdownClient && client) {
    try {
      await client.shutdown();
    } catch (error) {
      log("error", `Failed to shutdown client: ${error instanceof Error ? error.message : String(error)}`);
    }
    client = null;
  }

  updateControls();
}

function attachChannelHandlers(channel) {
  unsubscribeHandlers.push(
    channel.on("presenceEvent", (event) => {
      log("event", { presenceEvent: event });
    })
  );

  unsubscribeHandlers.push(
    channel.on("snapshot", (snapshot) => {
      log("event", { snapshot });
    })
  );

  unsubscribeHandlers.push(
    channel.on("heartbeatAck", (ack) => {
      log("event", { heartbeatAck: ack });
    })
  );

  unsubscribeHandlers.push(
    channel.on("disconnected", (payload) => {
      log("warn", `Socket disconnected: ${payload.reason}`);
      updateControls();
    })
  );

  unsubscribeHandlers.push(
    channel.on("error", (error) => {
      log("error", error instanceof Error ? error.message : String(error));
    })
  );
}

function disableJoinForm(disabled) {
  Array.from(joinForm.elements).forEach((el) => {
    if (el instanceof HTMLButtonElement) {
      el.disabled = disabled;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.disabled = disabled;
    }
  });
}

function updateControls() {
  const isConnected = Boolean(activeChannel);
  heartbeatBtn.disabled = !isConnected;
  patchBtn.disabled = !isConnected;
  customBtn.disabled = !isConnected;
  leaveBtn.disabled = !isConnected;
  patchSection.hidden = !isConnected;
  customSection.hidden = !isConnected;
}

function log(level, payload) {
  const timestamp = new Date().toISOString();
  const message =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  eventLog.textContent += `[${timestamp}] ${level.toUpperCase()}\n${message}\n\n`;
  eventLog.scrollTop = eventLog.scrollHeight;
}

updateControls();

function registerClientHooks(instance) {
  clientHookCleanups = [
    instance.onConnect(({ socketId }) => log("info", { connect: socketId })),
    instance.onDisconnect(({ reason }) => log("warn", { disconnect: reason })),
    instance.onReconnect(({ attempt, socketId }) => log("info", { reconnect: { attempt, socketId } })),
    instance.onReconnectAttempt(({ attempt }) => log("info", { reconnectAttempt: attempt })),
    instance.onMessage((event, payload) => log("event", { remote: { event, payload } })),
  ];
}

function cleanupClientHooks() {
  if (clientHookCleanups.length === 0) {
    return;
  }
  clientHookCleanups.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error("Failed to remove client hook", error);
    }
  });
  clientHookCleanups = [];
}
