export type EventHandler<Payload> = (payload: Payload) => void;

export class EventEmitter<EventMap extends Record<string, unknown>> {
  private readonly handlers: {
    [EventName in keyof EventMap]?: Set<EventHandler<EventMap[EventName]>>;
  } = {};

  on<EventName extends keyof EventMap>(event: EventName, handler: EventHandler<EventMap[EventName]>): () => void {
    const set = this.handlers[event] ?? new Set();
    set.add(handler as EventHandler<EventMap[EventName]>);
    this.handlers[event] = set;
    return () => this.off(event, handler);
  }

  once<EventName extends keyof EventMap>(event: EventName, handler: EventHandler<EventMap[EventName]>): () => void {
    const wrapper: EventHandler<EventMap[EventName]> = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  off<EventName extends keyof EventMap>(event: EventName, handler: EventHandler<EventMap[EventName]>): void {
    const set = this.handlers[event];
    if (!set) {
      return;
    }
    set.delete(handler as EventHandler<EventMap[EventName]>);
    if (set.size === 0) {
      delete this.handlers[event];
    }
  }

  emit<EventName extends keyof EventMap>(event: EventName, payload: EventMap[EventName]): void {
    const set = this.handlers[event];
    if (!set) {
      return;
    }
    set.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        // Swallow handler errors to avoid breaking other subscribers
        console.error(`EventEmitter handler for ${String(event)} threw`, error);
      }
    });
  }

  removeAll(): void {
    Object.keys(this.handlers).forEach((key) => delete this.handlers[key as keyof EventMap]);
  }
}
