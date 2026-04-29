import { getAgent } from "../agents/registry.js";
import { callWithFallback, callWithFallbackStream, bestModelForModality } from "../openrouter/models.js";
import { generateImage, generateSpeech, generateMusic } from "../openrouter/media.js";

const SYSTEM_PROMPTS = {
  researcher: `You are a research specialist for MindPortalix. Respond in clean Markdown. Ground claims with factual information and cite sources when available. Do not output internal tokens, step markers, or chain-of-thought brackets.`,
  coder: `You are a coding specialist for MindPortalix. Respond in clean Markdown with properly fenced code blocks. Write idiomatic, working code with brief explanations. Do not output internal tokens or step markers.`,
  writer: `You are a writing specialist for MindPortalix. Draft clear, well-structured content in clean Markdown. Adapt tone and format to the audience. Do not output internal tokens or step markers.`,
  memory: `You are a memory specialist for MindPortalix. Surface relevant past context concisely in clean Markdown. Do not output internal tokens or step markers.`,
  governor: `You are a safety specialist for MindPortalix. Briefly report on safety, PII, and policy concerns in clean Markdown. Do not output internal tokens or step markers.`,
  planner: `You are a planning specialist for MindPortalix. Provide a clear, structured plan in clean Markdown with numbered steps or bullet points. Do not output internal tokens, bracket markers like [[A0]], or step notation like [:].`,
  formatter: `You are a formatting specialist for MindPortalix. Return clean, well-formatted Markdown. Do not output internal tokens or step markers.`,
  orchestrator: `You are MindPortalix, an intelligent AI assistant. Be helpful, accurate, and clear. Respond in clean Markdown. Do not output internal reasoning tokens or step markers.`
};

/**
 * Split model output into { thinking, answer }.
 * Handles:
 *   • <think>…</think> tags  (DeepSeek R1, QwQ, etc.)
 *   • [[token]] / [N:] / [:] inline reasoning markers (Qwen, some Mistral variants)
 */
export function parseContent(raw) {
  if (!raw) return { thinking: null, answer: "" };

  // 1. Explicit <think> wrapper (DeepSeek R1, QwQ, etc.)
  const thinkMatch = raw.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/i);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const answer   = thinkMatch[2].trim();
    return { thinking: thinking || null, answer: answer || raw };
  }

  // 2. Inline bracket markers — lines that are purely reasoning tokens
  //    Matches: [[A0]], [[B1]], [16.0:], [:]
  const THINKING_LINE = /^(\[\[.*?\]\]|\[\d+\.?\d*:\]|\[:\])\s*/;

  const lines = raw.split("\n");
  const thinkLines  = [];   // lines that start with a marker
  const answerLines = [];   // lines that are clean prose

  for (const line of lines) {
    if (THINKING_LINE.test(line.trim())) {
      thinkLines.push(line);
    } else {
      answerLines.push(line);
    }
  }

  // No thinking markers found — content is already clean
  if (thinkLines.length === 0) return { thinking: null, answer: raw };

  const cleanAnswer = answerLines.join("\n").trim();

  // Case A: mixed — some clean prose lines exist alongside marker lines
  if (cleanAnswer.length > 10) {
    return { thinking: thinkLines.join("\n").trim(), answer: cleanAnswer };
  }

  // Case B: ALL lines are markers (common when model outputs only step notation).
  //   Extract the text portion that follows each marker as the visible answer.
  //   Keep the full raw content as the collapsible thinking log.
  const extractedParts = thinkLines
    .map(line => line.replace(THINKING_LINE, "").trim())
    .filter(Boolean);

  const extractedAnswer = extractedParts.join(" ").trim();

  if (extractedAnswer.length > 3) {
    return { thinking: raw, answer: extractedAnswer };
  }

  // Nothing useful to extract — show as-is with no thinking panel
  return { thinking: null, answer: raw };
}

/**
 * Run a specialist agent.
 * Returns { agent, model, content, mediaType?, mediaUrl? }
 *   mediaType: "image" | "audio" | undefined
 *   mediaUrl:  URL or data-URI for the generated media (when present)
 *   content:   text description / caption for the media, or the full text response
 */
export async function runSpecialistAgent({ agentId, input, memories = [], onStreamChunk, onStreamReset } = {}) {
  const agent = getAgent(agentId);

  // ── Image generation agent ─────────────────────────────────────────────
  if (agent.modality === "image") {
    return runImageAgent({ agent, input });
  }

  // ── Audio generation agent ─────────────────────────────────────────────
  if (agent.modality === "audio") {
    return runAudioAgent({ agent, input });
  }

  // ── Text / LLM agent (default) ─────────────────────────────────────────
  const systemPrompt = SYSTEM_PROMPTS[agentId]
    ?? `You are the ${agent.name} specialist. ${agent.responsibilities.join(". ")}.`;

  const memoryContext = memories.length > 0
    ? `\n\nRelevant context from memory:\n${memories.map(m => `- ${m.topic}: ${m.summary}`).join("\n")}`
    : "";

  const messages = [
    { role: "system", content: systemPrompt + memoryContext },
    { role: "user", content: input },
  ];

  const useStream = typeof onStreamChunk === "function";

  try {
    if (useStream) {
      const { content, model } = await callWithFallbackStream({
        role: agentId,
        messages,
        maxAttempts: 5,
        onChunk: onStreamChunk,
        onReset: onStreamReset,
      });
      return { agent: agentId, model, content };
    }
    const { content, model } = await callWithFallback({ role: agentId, messages, maxAttempts: 5 });
    return { agent: agentId, model, content };
  } catch (err) {
    return { agent: agentId, model: agent.model, content: friendlyError(err), error: err.message };
  }
}

// ── Image agent ────────────────────────────────────────────────────────────
async function runImageAgent({ agent, input }) {
  try {
    const model = await bestModelForModality("image", "image_generator");
    const { url } = await generateImage({ prompt: input, model });
    return {
      agent: agent.id,
      model,
      content: `Generated image for: "${input.slice(0, 80)}"`,
      mediaType: "image",
      mediaUrl: url,
    };
  } catch (err) {
    console.error("[agent:image_generator] failed:", err.message);
    return {
      agent: agent.id,
      model: agent.model,
      content: `Image generation failed: ${err.message}`,
      error: err.message,
    };
  }
}

// ── Audio agent ────────────────────────────────────────────────────────────
async function runAudioAgent({ agent, input }) {
  // Detect TTS vs music intent
  const isTts = /\b(text[- ]to[- ]speech|tts|read[- ]aloud|narrat|speak|voice[- ]?over)\b/i.test(input);

  try {
    if (isTts) {
      // Extract the text to speak (strip the "read aloud:" prefix if present)
      const ttsText = input.replace(/^(read\s+aloud|narrate|speak|tts|text[- ]to[- ]speech)[:\s]*/i, "").trim() || input;
      const model   = await bestModelForModality("audio", "audio_generator");
      const { dataUri } = await generateSpeech({ text: ttsText, model });
      return {
        agent: agent.id,
        model,
        content: `Speech generated for: "${ttsText.slice(0, 80)}"`,
        mediaType: "audio",
        mediaUrl: dataUri,
      };
    } else {
      // Music generation
      const model = await bestModelForModality("audio", "audio_generator");
      const { url } = await generateMusic({ prompt: input, model });
      return {
        agent: agent.id,
        model,
        content: `Music generated for: "${input.slice(0, 80)}"`,
        mediaType: "audio",
        mediaUrl: url,
      };
    }
  } catch (err) {
    console.error("[agent:audio_generator] failed:", err.message);
    return {
      agent: agent.id,
      model: agent.model,
      content: `Audio generation failed: ${err.message}`,
      error: err.message,
    };
  }
}

// ── Error helpers ──────────────────────────────────────────────────────────
function friendlyError(err) {
  if (err.message.includes("401") || err.message.includes("Invalid OpenRouter API key")) {
    return err.message; // triggers API-key error banner
  }
  if (err.message.includes("429") || err.message.includes("rate-limit") ||
      err.message.includes("rate limited") || err.message.includes("temporarily rate-limited")) {
    return "All free AI models are currently at capacity. Please wait a moment and try again.";
  }
  return "The AI service is temporarily unavailable. Please try again shortly.";
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
