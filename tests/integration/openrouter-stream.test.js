import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accumulateOpenRouterSseStream } from "../../src/openrouter/models.js";

describe("OpenRouter SSE stream parsing", () => {
  it("accumulates content and forwards deltas", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n',
      "data: [DONE]\n",
    ].join("");

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });

    const chunks = [];
    const full = await accumulateOpenRouterSseStream(body, (d) => chunks.push(d));

    assert.equal(full, "Hello world");
    assert.deepEqual(chunks, ["Hello", " world"]);
  });
});
