import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function broadcast(event, data) {
  bus.emit("monitor_event", { event, data, ts: Date.now() });
}

export function subscribe(handler) {
  bus.on("monitor_event", handler);
  return () => bus.off("monitor_event", handler);
}
