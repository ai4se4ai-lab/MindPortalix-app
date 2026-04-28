import { getAgent } from "../agents/registry.js";
import { callWithFallback } from "../openrouter/models.js";

const SYSTEM_PROMPTS = {
  researcher: `You are a research specialist. Ground claims with factual information, cite sources when available, highlight recent developments, and flag uncertain or outdated information. Be precise and accurate.`,
  coder: `You are a coding specialist. Write clean, idiomatic code in the requested language, debug and explain issues clearly, follow existing patterns, and include focused tests when appropriate.`,
  writer: `You are a writing specialist. Draft clear, well-structured content, adapt tone and format to the audience, summarize complex topics accessibly, and polish language and flow.`,
  memory: `You are a memory specialist. Surface relevant past context, identify durable preferences and project facts, compress session summaries accurately, and tag information by topic and importance.`,
  governor: `You are a safety and governance specialist. Detect PII, secrets, and sensitive data, enforce content safety policies, flag potentially harmful instructions, and ensure compliance with usage guidelines.`,
  planner: `You are a planning specialist. Break complex work into clear milestones, sequence tasks with dependencies, identify risks and blockers, and create actionable realistic plans with clear next steps.`,
  formatter: `You are a formatting specialist. Render Markdown beautifully, produce clean JSON or tables on request, normalize output structure, and apply consistent formatting for maximum readability.`,
  orchestrator: `You are MindPortalix, an intelligent AI assistant. Be helpful, accurate, clear, and adapt your tone to the user's request.`
};

export async function runSpecialistAgent({ agentId, input, memories = [] }) {
  const agent = getAgent(agentId);
  const systemPrompt = SYSTEM_PROMPTS[agentId]
    ?? `You are the ${agent.name} specialist. ${agent.responsibilities.join(". ")}.`;

  const memoryContext = memories.length > 0
    ? `\n\nRelevant context from memory:\n${memories.map(m => `- ${m.topic}: ${m.summary}`).join("\n")}`
    : "";

  const messages = [
    { role: "system", content: systemPrompt + memoryContext },
    { role: "user", content: input }
  ];

  try {
    const { content, model } = await callWithFallback({ role: agentId, messages });
    return { agent: agentId, model, content };
  } catch (err) {
    return {
      agent: agentId,
      model: agent.model,
      content: err.message,
      error: err.message
    };
  }
}

export function reviewDraft({ draft, route, threshold = 7 }) {
  const issues = [];
  let score = 8;

  if (!draft || draft.length < 40) {
    issues.push("Draft is too short to be useful.");
    score -= 2;
  }
  if (route.agents.includes("researcher") && !/source|citation|retrieval|ground/i.test(draft)) {
    issues.push("Research path should mention grounding or citations.");
    score -= 1;
  }
  if (/api[_-]?key|service_role|password/i.test(draft)) {
    issues.push("Draft may expose sensitive credential language.");
    score -= 2;
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    passed: score >= threshold && issues.length === 0,
    threshold,
    issues,
    confidence: score >= 8 ? "high" : score >= 6 ? "medium" : "low"
  };
}
