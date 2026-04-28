import { inspectToolUse } from "../src/hooks/safety.js";

export function preToolUse(event) {
  return inspectToolUse({
    command: event?.command,
    content: event?.content
  });
}
