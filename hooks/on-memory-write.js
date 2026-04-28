import { sanitizeMemoryText } from "../src/hooks/safety.js";

export function onMemoryWrite(event) {
  return {
    ...event,
    summary: sanitizeMemoryText(event?.summary),
    sanitized: true
  };
}
