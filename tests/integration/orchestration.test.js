import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MindPortalixOrchestrator } from "../../src/orchestration/orchestrator.js";
import { InMemoryMemoryStore } from "../../src/storage/memory-store.js";

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
    const orchestrator = new MindPortalixOrchestrator({ memoryStore });

    const result = await orchestrator.handleRequest({
      userId: "user-1",
      input: "Plan and implement a Supabase memory API with tests"
    });

    assert.equal(result.route.primary, "coder");
    assert.ok(result.route.agents.includes("planner"));
    assert.ok(result.route.agents.includes("reviewer"));
    assert.equal(result.review.passed, true);
    assert.match(result.final, /Relevant memory/);

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
