/**
 * OpenRouter free-model discovery and selection.
 * Fetches the live models list, filters by zero-cost models,
 * groups by output modality, and maps text models to agent roles.
 *
 * Supported modalities: "text" | "image" | "audio"
 */

const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

// ── Fallback lists used when the live API call fails ───────────────────────
const KNOWN_FREE_MODELS = {
  text: [
    "google/gemma-3-12b-it:free",
    "google/gemma-3-8b-it:free",
    "google/gemma-3-4b-it:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "qwen/qwen-2.5-7b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "microsoft/phi-3-mini-128k-instruct:free",
    "deepseek/deepseek-r1-distill-llama-70b:free",
    "deepseek/deepseek-r1:free",
    "google/gemini-2.0-flash-exp:free",
  ],
  image: [
    "black-forest-labs/flux-1-schnell:free",
    "stabilityai/stable-diffusion-xl-base-1.0:free",
  ],
  audio: [
    "google/lyria-3-pro-preview",
  ],
};

// Maps raw OpenRouter architecture.modality strings → our modality keys
const MODALITY_MAP = {
  "text->text":          "text",
  "text+image->text":    "text",   // vision-capable LLMs still produce text
  "text->image":         "image",
  "text->audio":         "audio",
  "text->text+image":    "image",  // multi-modal output — treat as image
};

// ── Preferred text model keywords per agent role ───────────────────────────
// Ordered by reliability + quality. Hermes (Venice) omitted — frequently rate-limited.
const ROLE_PREFERENCES = {
  researcher:    ["gemini", "gemma-3-12b", "gemma-3-8b", "qwen-2.5-72b", "llama-3.1-8b"],
  coder:         ["deepseek", "qwen-2.5-72b", "qwen", "phi", "llama"],
  writer:        ["gemma-3-8b", "gemma", "llama-3.1-8b", "mistral", "qwen"],
  planner:       ["qwen-2.5-72b", "deepseek-r1", "gemma-3-12b", "llama-3.1-8b", "gemma"],
  memory:        ["llama-3.1-8b", "gemma-3-8b", "mistral", "gemma", "qwen"],
  governor:      ["qwen-2.5-72b", "qwen", "llama", "gemma", "mistral"],
  formatter:     ["phi", "gemma-3-8b", "gemma", "mistral", "llama"],
  executor:      ["gemma-3-12b", "qwen-2.5-72b", "gemma-3-8b", "llama-3.1-8b", "gemma", "mistral"],
  reviewer:      ["qwen-2.5-72b", "deepseek-r1", "gemma-3-12b", "llama-3.1-8b", "gemma"],
  orchestrator:  ["gemini-2.0-flash", "qwen-2.5-72b", "gemma-3-12b", "gemma-3-8b", "llama-3.1-8b"],
  // media agents — model selection handled differently, but keep here for fallback labels
  image_generator: [],
  audio_generator: [],
};

// ── Per-modality cache ─────────────────────────────────────────────────────
const _cache    = {};
const _cacheAt  = {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch free models from OpenRouter filtered by output modality.
 * @param {"text"|"image"|"audio"} modality
 */
export async function getFreeModels(modality = "text") {
  const now = Date.now();
  if (_cache[modality] && now - _cacheAt[modality] < CACHE_TTL) {
    return _cache[modality];
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    }

    const res = await fetch(`${BASE_URL()}/models`, { headers });
    if (!res.ok) throw new Error(`models API returned ${res.status}`);

    const { data } = await res.json();

    const free = (data ?? [])
      .filter(m => {
        if (!m.id) return false;
        if (String(m.pricing?.prompt ?? "1") !== "0") return false;
        if (String(m.pricing?.completion ?? "1") !== "0") return false;

        const raw     = m.architecture?.modality ?? m.modality ?? "text->text";
        const mapped  = MODALITY_MAP[raw] ?? raw.split("->").pop();
        return mapped === modality;
      })
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .map(m => m.id);

    if (free.length === 0) throw new Error(`No free ${modality} models found`);

    _cache[modality] = free;
    _cacheAt[modality] = now;
    console.log(`[models] ${free.length} free ${modality} models loaded`);
    return free;
  } catch (err) {
    console.warn(`[models] Live fetch for "${modality}" failed (${err.message}), using fallback`);
    const fallback = KNOWN_FREE_MODELS[modality] ?? KNOWN_FREE_MODELS.text;
    _cache[modality] = fallback;
    _cacheAt[modality] = now;
    return fallback;
  }
}

/**
 * Return the best free model for an agent role (text only).
 */
export async function bestModelForRole(role) {
  const models = await getFreeModels("text");
  const prefs  = ROLE_PREFERENCES[role] ?? [];
  for (const kw of prefs) {
    const match = models.find(id => id.toLowerCase().includes(kw));
    if (match) return match;
  }
  return models[0] ?? KNOWN_FREE_MODELS.text[0];
}

/**
 * Return the best free model for a given output modality.
 * For "text", respects ROLE_PREFERENCES; for image/audio returns first available.
 */
export async function bestModelForModality(modality, role) {
  if (modality === "text") return bestModelForRole(role);
  const models = await getFreeModels(modality);
  return models[0] ?? KNOWN_FREE_MODELS[modality]?.[0];
}

// ── Text LLM caller ────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Call OpenRouter with automatic fallback through ranked free text models.
 * 401 → throws immediately (bad key).
 * 429/503 → waits 800ms, then tries the next model.
 */
export async function callWithFallback({ role, messages, maxAttempts = 5 }) {
  const models = await getFreeModels("text");
  const prefs  = ROLE_PREFERENCES[role] ?? [];

  // Models known to return empty/unusable responses — pushed to the end of the fallback list
  const UNRELIABLE = ["ling", "minimax", "ernie", "baichuan"];
  const isUnreliable = (id) => UNRELIABLE.some(kw => id.toLowerCase().includes(kw));

  // Build ranked list: preferred models first, then reliable free models, then unreliable ones last
  const ranked = [];
  for (const kw of prefs) {
    const match = models.find(id => id.toLowerCase().includes(kw) && !ranked.includes(id) && !isUnreliable(id));
    if (match) ranked.push(match);
  }
  for (const id of models) {
    if (!ranked.includes(id) && !isUnreliable(id)) ranked.push(id);
  }
  // Append unreliable models at the very end as last-resort fallbacks
  for (const id of models) {
    if (!ranked.includes(id)) ranked.push(id);
  }

  const attempts = ranked.slice(0, maxAttempts);
  let lastError;

  for (const model of attempts) {
    try {
      const res = await fetch(`${BASE_URL()}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": process.env.APP_URL ?? "https://mindportalix.app",
          "X-Title": "MindPortalix",
        },
        body: JSON.stringify({ model, messages, temperature: 0.3 }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 401) {
          throw new Error(`Invalid OpenRouter API key (401). Update OPENROUTER_API_KEY in .env. Details: ${body}`);
        }
        lastError = new Error(`${model} failed (${res.status}): ${body}`);
        console.warn(`[models] ${model} → ${res.status}, trying next…`);
        if (res.status === 429) await sleep(800);
        continue;
      }

      const data    = await res.json();
      const content = (data.choices?.[0]?.message?.content ?? "").trim();

      // Treat empty / whitespace-only responses as failures — try the next model
      if (!content) {
        lastError = new Error(`${model} returned an empty response`);
        console.warn(`[models] ${model} → empty response, trying next…`);
        continue;
      }

      return { content, model };
    } catch (err) {
      if (err.message.includes("401") || err.message.includes("Invalid OpenRouter API key")) {
        throw err;
      }
      lastError = err;
      console.warn(`[models] ${model} threw: ${err.message}, trying next…`);
    }
  }

  throw lastError ?? new Error("All free text models exhausted");
}

/**
 * Stream chat completions with the same fallback strategy as callWithFallback.
 * Invokes onChunk with each text delta. Calls onReset before retrying another model
 * if any deltas were already emitted for the failed attempt.
 */
export async function callWithFallbackStream({
  role,
  messages,
  maxAttempts = 5,
  onChunk,
  onReset,
}) {
  if (typeof onChunk !== "function") {
    throw new Error("callWithFallbackStream requires onChunk");
  }

  const models = await getFreeModels("text");
  const prefs = ROLE_PREFERENCES[role] ?? [];
  const UNRELIABLE = ["ling", "minimax", "ernie", "baichuan"];
  const isUnreliable = (id) => UNRELIABLE.some((kw) => id.toLowerCase().includes(kw));

  const ranked = [];
  for (const kw of prefs) {
    const match = models.find(
      (id) => id.toLowerCase().includes(kw) && !ranked.includes(id) && !isUnreliable(id)
    );
    if (match) ranked.push(match);
  }
  for (const id of models) {
    if (!ranked.includes(id) && !isUnreliable(id)) ranked.push(id);
  }
  for (const id of models) {
    if (!ranked.includes(id)) ranked.push(id);
  }

  const attempts = ranked.slice(0, maxAttempts);
  let lastError;

  for (const model of attempts) {
    let emitted = false;
    const safeChunk = (d) => {
      emitted = true;
      onChunk(d);
    };

    try {
      const res = await fetch(`${BASE_URL()}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": process.env.APP_URL ?? "https://mindportalix.app",
          "X-Title": "MindPortalix",
        },
        body: JSON.stringify({ model, messages, temperature: 0.3, stream: true }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 401) {
          throw new Error(
            `Invalid OpenRouter API key (401). Update OPENROUTER_API_KEY in .env. Details: ${body}`
          );
        }
        lastError = new Error(`${model} failed (${res.status}): ${body}`);
        console.warn(`[models:stream] ${model} → ${res.status}, trying next…`);
        if (res.status === 429) await sleep(800);
        continue;
      }

      const content = await accumulateOpenRouterSseStream(res.body, safeChunk);

      if (!content.trim()) {
        if (emitted) onReset?.();
        lastError = new Error(`${model} returned an empty streamed response`);
        console.warn(`[models:stream] ${model} → empty stream, trying next…`);
        continue;
      }

      return { content, model };
    } catch (err) {
      if (emitted) onReset?.();
      if (err.message.includes("401") || err.message.includes("Invalid OpenRouter API key")) {
        throw err;
      }
      lastError = err;
      console.warn(`[models:stream] ${model} threw: ${err.message}, trying next…`);
    }
  }

  throw lastError ?? new Error("All free text models exhausted");
}

/**
 * Parse OpenRouter/OpenAI-style SSE from a fetch Response body; accumulate full text
 * and invoke onChunk for each content delta.
 */
export async function accumulateOpenRouterSseStream(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {
        /* ignore malformed chunks */
      }
    }
  }

  const rest = buffer.trim();
  if (rest.startsWith("data:")) {
    const data = rest.slice(5).trim();
    if (data && data !== "[DONE]") {
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return full;
}
