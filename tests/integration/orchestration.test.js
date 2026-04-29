import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MindPortalixOrchestrator } from "../../src/orchestration/orchestrator.js";
import { InMemoryMemoryStore } from "../../src/storage/memory-store.js";

// Stub agent runner — no real OpenRouter calls needed in integration tests
const stubRunner = async ({ agentId }) => ({
  agent: agentId,
  model: `stub/${agentId}`,
  content: `Stub response from ${agentId}. Relevant context retrieved and validated. Citations included.`
});

describe("MindPortalix orchestration", () => {
  it("routes through specialists, reviewer, and writes memory", async () => {
    const memoryStore = new InMemoryMemoryStore([
      {
        userId: "user-1",
        topic: "preferences",
        summary: "User prefers concise Markdown answers about Supabase.",
        importance: 5
      }
    ]);
    const orchestrator = new MindPortalixOrchestrator({ memoryStore, agentRunner: stubRunner });

    const result = await orchestrator.handleRequest({
      userId: "user-1",
      input: "Plan and implement a Supabase memory API with tests"
    });

    // Routing is deterministic (keyword-based)
    assert.equal(result.route.primary, "coder");
    assert.ok(result.route.agents.includes("planner"));
    assert.ok(result.route.agents.includes("reviewer"));

    // Review runs on the composed draft
    assert.ok(typeof result.review.score === "number");
    assert.ok(result.review.score >= 0 && result.review.score <= 10);

    // Memory line is included in the draft
    assert.match(result.final, /Relevant memory/);

    // A memory entry was written for this session
    const memories = await memoryStore.all("user-1");
    assert.equal(memories.length, 2);
  });

  it("isolates memory by user", async () => {
    const memoryStore = new InMemoryMemoryStore([
      { userId: "alice", topic: "profile", summary: "Alice likes tables.", importance: 5 },
      { userId: "bob", topic: "profile", summary: "Bob likes prose.", importance: 5 }
    ]);

    const results = await memoryStore.search({ userId: "alice", query: "profile prose tables" });

    assert.equal(results.length, 1);
    assert.equal(results[0].summary, "Alice likes tables.");
  });
});
