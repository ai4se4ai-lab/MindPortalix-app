import { listAgents } from "../agents/registry.js";
import { detectModalities, MODALITY } from "./modality.js";

const MIN_CONFIDENCE = 0.25;

// Simple conversational inputs don't need planning — route to writer
const CONVERSATIONAL = /^(hi|hello|hey|howdy|greetings|sup|yo|what'?s up|good\s+(morning|afternoon|evening|day)|how are you|how r u|thanks|thank you|bye|goodbye|ok|okay|sure|cool|nice|great|awesome)[\s!?.]*$/i;

export function classifyIntent(input) {
  // ── 1. Modality detection ──────────────────────────────────────────────
  const modalities = detectModalities(input);
  const needsImage = modalities.includes(MODALITY.IMAGE);
  const needsAudio = modalities.includes(MODALITY.AUDIO);

  // ── 2. Media-only shortcut ─────────────────────────────────────────────
  // If the request is clearly about generating media, route directly to the
  // appropriate media agent (no text specialists needed).
  if (needsImage && !needsAudio) {
    return {
      primary: "image_generator",
      agents: ["image_generator"],
      modalities,
      confidence: 1.0,
      matchedKeywords: ["image generation"],
    };
  }
  if (needsAudio && !needsImage) {
    return {
      primary: "audio_generator",
      agents: ["audio_generator"],
      modalities,
      confidence: 1.0,
      matchedKeywords: ["audio generation"],
    };
  }
  if (needsImage && needsAudio) {
    // Both: generate image + audio (e.g. "create an image and a soundtrack")
    return {
      primary: "image_generator",
      agents: ["image_generator", "audio_generator"],
      modalities,
      confidence: 1.0,
      matchedKeywords: ["image generation", "audio generation"],
    };
  }

  // ── 3. Conversational shortcut ─────────────────────────────────────────
  if (CONVERSATIONAL.test(input.trim())) {
    return {
      primary: "writer",
      agents: ["writer"],
      modalities,
      confidence: 1.0,
      matchedKeywords: ["conversational"],
    };
  }

  // ── 4. Keyword-based text routing ──────────────────────────────────────
  const text = normalizeText(input);
  const candidates = listAgents()
    .filter(a => a.id !== "orchestrator" && !a.modality) // exclude media & orchestrator
    .map(agent => {
      const matchedKeywords = agent.keywords.filter(kw => text.includes(kw));
      return {
        agent: agent.id,
        confidence: scoreConfidence(matchedKeywords.length, agent.keywords.length),
        matchedKeywords,
      };
    })
    .filter(c => c.confidence >= MIN_CONFIDENCE || c.matchedKeywords.length > 0)
    .sort((a, b) => b.confidence - a.confidence || a.agent.localeCompare(b.agent));

  const primary = candidates[0]?.agent ?? "planner";
  const requiresReview = primary !== "reviewer";

  return {
    primary,
    agents: ensureReviewer(candidates.map(c => c.agent), requiresReview),
    modalities,
    confidence: candidates[0]?.confidence ?? MIN_CONFIDENCE,
    matchedKeywords: candidates.flatMap(c => c.matchedKeywords),
  };
}

function ensureReviewer(agentIds, requiresReview) {
  const unique = [...new Set(agentIds.length > 0 ? agentIds : ["planner"])];
  if (requiresReview && !unique.includes("reviewer")) unique.push("reviewer");
  return unique;
}

function scoreConfidence(matchCount, keywordCount) {
  if (matchCount === 0 || keywordCount === 0) return 0;
  return Math.min(1, 0.2 + matchCount / Math.max(keywordCount, 4));
}

function normalizeText(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ");
}
