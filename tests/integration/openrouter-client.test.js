import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatCompletionRequest } from "../../src/openrouter/client.js";

describe("OpenRouter client", () => {
  it("builds a deterministic chat completion request", () => {
    const request = createChatCompletionRequest({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1/",
      appUrl: "http://localhost:3000",
      model: "mistralai/mistral-7b-instruct",
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.Authorization, "Bearer test-key");
    assert.equal(request.init.headers["HTTP-Referer"], "http://localhost:3000");

    const body = JSON.parse(request.init.body);
    assert.equal(body.model, "mistralai/mistral-7b-instruct");
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  });
});
