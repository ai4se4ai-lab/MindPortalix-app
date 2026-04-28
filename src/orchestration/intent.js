import { listAgents } from "../agents/registry.js";

const MIN_CONFIDENCE = 0.25;

export function classifyIntent(input) {
  const text = normalizeText(input);
  const agents = listAgents()
    .filter((agent) => agent.id !== "orchestrator")
    .map((agent) => {
      const matchedKeywords = agent.keywords.filter((keyword) => text.includes(keyword));
      return {
        agent: agent.id,
        confidence: scoreConfidence(matchedKeywords.length, agent.keywords.length),
        matchedKeywords
      };
    })
    .filter((candidate) => candidate.confidence >= MIN_CONFIDENCE || candidate.matchedKeywords.length > 0)
    .sort((left, right) => right.confidence - left.confidence || left.agent.localeCompare(right.agent));

  const primary = agents[0]?.agent ?? "planner";
  const requiresReview = primary !== "reviewer";

  return {
    primary,
    agents: ensureReviewer(agents.map((candidate) => candidate.agent), requiresReview),
    confidence: agents[0]?.confidence ?? MIN_CONFIDENCE,
    matchedKeywords: agents.flatMap((candidate) => candidate.matchedKeywords)
  };
}

function ensureReviewer(agentIds, requiresReview) {
  const uniqueAgents = [...new Set(agentIds.length > 0 ? agentIds : ["planner"])];
  if (requiresReview && !uniqueAgents.includes("reviewer")) {
    uniqueAgents.push("reviewer");
  }
  return uniqueAgents;
}

function scoreConfidence(matchCount, keywordCount) {
  if (matchCount === 0 || keywordCount === 0) {
    return 0;
  }
  return Math.min(1, 0.2 + matchCount / Math.max(keywordCount, 4));
}

function normalizeText(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ");
}
