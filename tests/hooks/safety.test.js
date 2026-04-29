import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectToolUse, sanitizeMemoryText } from "../../src/hooks/safety.js";

describe("hook safety checks", () => {
  it("blocks destructive commands", () => {
    const result = inspectToolUse({ command: "git reset --hard HEAD" });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Unsafe destructive operation detected");
  });

  it("blocks likely secret exposure", () => {
    const result = inspectToolUse({ content: "OPENROUTER_API_KEY=sk-test-secret-token-value" });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Potential secret exposure detected");
  });

  it("allows ordinary commands", () => {
    const result = inspectToolUse({ command: "npm test" });
    assert.equal(result.allowed, true);
  });

  it("sanitizes sensitive memory text", () => {
    const sanitized = sanitizeMemoryText("Email me@example.com and card 4111 1111 1111 1111");
    assert.equal(sanitized, "Email [email] and card [card]");
  });
});
