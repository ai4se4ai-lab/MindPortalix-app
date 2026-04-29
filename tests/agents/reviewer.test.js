import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewDraft } from "../../src/orchestration/responses.js";

describe("reviewer scoring", () => {
  it("passes complete drafts", () => {
    const review = reviewDraft({
      draft: "This response includes enough detail to answer the user, explains the route, and includes validation notes.",
      route: { agents: ["planner", "reviewer"] }
    });

    assert.equal(review.passed, true);
    assert.equal(review.score, 8);
  });

  it("fails drafts that are too short", () => {
    const review = reviewDraft({
      draft: "Too short.",
      route: { agents: ["planner", "reviewer"] }
    });

    assert.equal(review.passed, false);
    assert.ok(review.issues.includes("Draft is too short to be useful."));
  });
});
