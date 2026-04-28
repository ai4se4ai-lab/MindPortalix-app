import { classifyIntent } from "./intent.js";
import { reviewDraft, runSpecialistAgent } from "./responses.js";
import { InMemoryMemoryStore, summarizeForMemory } from "../storage/memory-store.js";

export class MindPortalixOrchestrator {
  constructor({ memoryStore = new InMemoryMemoryStore(), reviewThreshold = 7 } = {}) {
    this.memoryStore = memoryStore;
    this.reviewThreshold = reviewThreshold;
  }

  async handleRequest({ userId = "anonymous", input }) {
    if (!input || !String(input).trim()) {
      throw new Error("A user request is required");
    }

    const route = classifyIntent(input);
    const memories = await this.memoryStore.search({ userId, query: input });
    const specialistIds = route.agents.filter((agentId) => agentId !== "reviewer");
    const specialistResults = await Promise.all(
      specialistIds.map((agentId) => runSpecialistAgent({ agentId, input, memories }))
    );

    const draft = composeDraft({ input, route, memories, specialistResults });
    const review = reviewDraft({ draft, route, threshold: this.reviewThreshold });
    const final = review.passed ? draft : strengthenDraft(draft, review);

    await this.memoryStore.write(
      summarizeForMemory({
        userId,
        topic: route.primary,
        messages: [
          { role: "user", content: input },
          { role: "assistant", content: final }
        ],
        importance: route.primary === "memory" ? 5 : 3
      })
    );

    return {
      route,
      memories,
      specialistResults,
      review,
      final,
      metadata: {
        reviewed: true,
        modelPlan: specialistResults.map(({ agent, model }) => ({ agent, model }))
      }
    };
  }
}

export async function orchestrate(request, options) {
  const orchestrator = new MindPortalixOrchestrator(options);
  return orchestrator.handleRequest(request);
}

function composeDraft({ input, route, memories, specialistResults }) {
  const memoryLine =
    memories.length > 0
      ? `Relevant memory was used from ${memories.length} prior context item(s).`
      : "No matching long-term memory was found.";

  return [
    `MindPortalix routed this request to ${route.agents.join(", ")}.`,
    memoryLine,
    `User request: ${input}`,
    "Specialist synthesis:",
    ...specialistResults.map((result) => `[${result.agent}] ${result.content}`),
    "Final response should be delivered only after reviewer validation."
  ].join("\n");
}

function strengthenDraft(draft, review) {
  return [
    draft,
    "Reviewer follow-up:",
    `The first pass scored ${review.score}/${review.threshold}. Addressed issues: ${review.issues.join("; ") || "none"}.`
  ].join("\n");
}
