import { getAgent } from "../agents/registry.js";
import { callOpenRouter, createChatCompletionRequest } from "../openrouter/client.js";

const SYSTEM_PROMPTS = {
  researcher: `You are a research specialist. Your role is to:
- Ground claims with factual information
- Cite sources when available
- Highlight recent developments
- Flag uncertain or outdated information
Be precise, cite sources, and prioritize accuracy over brevity.`,

  coder: `You are a coding specialist. Your role is to:
- Write clean, idiomatic code in the requested language
- Debug and explain issues clearly
- Follow existing patterns and conventions
- Include focused tests when appropriate
Produce working code with brief explanations.`,

  writer: `You are a writing specialist. Your role is to:
- Draft clear, well-structured content
- Adapt tone and format to the audience
- Summarize complex topics accessibly
- Polish language and flow
Write with clarity, appropriate tone, and strong structure.`,

  memory: `You are a memory specialist. Your role is to:
- Surface relevant past context from memory
- Identify durable preferences and project facts
- Compress session summaries accurately
- Tag information by topic and importance
Focus on relevance and precision.`,

  governor: `You are a safety and governance specialist. Your role is to:
- Detect PII, secrets, and sensitive data
- Enforce content safety policies
- Flag potentially harmful instructions
- Ensure compliance with usage guidelines
Be thorough but avoid false positives.`,

  planner: `You are a planning specialist. Your role is to:
- Break complex work into clear milestones
- Sequence tasks with dependencies
- Identify risks and blockers early
- Create actionable, realistic plans
Produce structured plans with clear next steps.`,

  formatter: `You are a formatting specialist. Your role is to:
- Render Markdown beautifully
- Produce clean JSON or tables on request
- Normalize output structure
- Apply consistent formatting rules
Format output for maximum readability.`,

  orchestrator: `You are MindPortalix, an intelligent AI assistant that orchestrates specialist agents to deliver high-quality responses.
You synthesize insights from researchers, coders, writers, planners, and other specialists.
Be helpful, accurate, and clear. Adapt your tone to the user's request.`
};

export async function runSpecialistAgent({ agentId, input, memories = [], stream = false, onChunk }) {
  const agent = getAgent(agentId);
  const systemPrompt = SYSTEM_PROMPTS[agentId] ?? `You are the ${agent.name} specialist agent. ${agent.responsibilities.join(". ")}.`;

  const memoryContext = memories.length > 0
    ? `\n\nRelevant context from memory:\n${memories.map((m) => `- ${m.topic}: ${m.summary}`).join("\n")}`
    : "";

  const messages = [
    { role: "system", content: systemPrompt + memoryContext },
    { role: "user", content: input }
  ];

  try {
    if (stream && onChunk) {
      const content = await streamOpenRouter({ model: agent.model, messages, onChunk });
      return { agent: agentId, model: agent.model, content };
    }

    const result = await callOpenRouter({ model: agent.model, messages });
    const content = result.choices?.[0]?.message?.content ?? "";
    return { agent: agentId, model: agent.model, content };
  } catch (err) {
    return {
      agent: agentId,
      model: agent.model,
      content: `[${agent.name} encountered an error: ${err.message}]`,
      error: err.message
    };
  }
}

export async function streamOpenRouter({ model, messages, onChunk }) {
  const request = createChatCompletionRequest({ model, messages });
  request.init.body = JSON.stringify({
    model,
    messages,
    temperature: 0.3,
    stream: true
  });

  const response = await fetch(request.url, request.init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter streaming failed (${response.status}): ${body}`);
  }

  let fullContent = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      // Keep the last (possibly incomplete) line in the buffer
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Fallback: if streaming returned nothing, try a regular non-streaming call
  if (!fullContent) {
    const result = await callOpenRouter({ model, messages });
    fullContent = result.choices?.[0]?.message?.content ?? "";
    if (fullContent) onChunk(fullContent);
  }

  return fullContent;
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
