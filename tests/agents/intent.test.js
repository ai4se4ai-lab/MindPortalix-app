import assert from "node:assert/strict";
import { describe, it } from "node:test";
import prompts from "../fixtures/sample-prompts.json" with { type: "json" };
import { classifyIntent } from "../../src/orchestration/intent.js";
import { getAgent, listAgents } from "../../src/agents/registry.js";

describe("agent registry", () => {
  it("contains all MVP agents with models", () => {
    const agents = listAgents();
    assert.equal(agents.length, 12); // text agents (incl. executor) + image_generator + audio_generator
    assert.ok(agents.every((agent) => agent.id && agent.model));
    assert.equal(getAgent("reviewer").name, "Reviewer");
  });
});

describe("intent classification", () => {
  for (const fixture of prompts) {
    it(`routes "${fixture.input}" to ${fixture.expectedPrimary}`, () => {
      const route = classifyIntent(fixture.input);
      assert.equal(route.primary, fixture.expectedPrimary);
      assert.ok(route.agents.includes("reviewer"));
      assert.ok(route.confidence > 0);
    });
  }

  it("falls back to planner for ambiguous requests", () => {
    const route = classifyIntent("Help me think through this");
    assert.equal(route.primary, "planner");
    assert.deepEqual(route.agents, ["planner", "reviewer"]);
  });
});
