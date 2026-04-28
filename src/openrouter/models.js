/**
 * OpenRouter free-model discovery and selection.
 * Fetches the live models list, filters to zero-cost models,
 * ranks them, and maps them to agent roles.
 */

const BASE_URL = () => (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

// Fallback list of known-good free models (used if the API call fails)
const KNOWN_FREE_MODELS = [
  "google/gemma-3-12b-it:free",
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
  "nousresearch/hermes-3-llama-3.1-405b:free"
];

// Preferred model keywords mapped to agent roles
const ROLE_PREFERENCES = {
  researcher:  ["gemini", "gemma-3-12b", "llama-3.1-8b", "qwen-2.5-72b"],
  coder:       ["deepseek", "qwen", "phi", "llama"],
  writer:      ["gemma", "llama-3.1-8b", "mistral", "hermes"],
  planner:     ["qwen-2.5-72b", "deepseek-r1", "llama-3.1-8b", "gemma-3-12b"],
  memory:      ["llama-3.1-8b", "mistral", "gemma", "qwen"],
  governor:    ["qwen", "llama", "gemma", "mistral"],
  formatter:   ["phi", "gemma", "mistral", "llama"],
  reviewer:    ["qwen-2.5-72b", "deepseek-r1", "llama-3.1-8b", "gemma-3-12b"],
  orchestrator:["gemini-2.0-flash", "qwen-2.5-72b", "gemma-3-12b", "llama-3.1-8b"]
};

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function getFreeModels() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    }

    const res = await fetch(`${BASE_URL()}/models`, { headers });
    if (!res.ok) throw new Error(`models API returned ${res.status}`);

    const { data } = await res.json();

    const free = (data ?? [])
      .filter(m =>
        m.id &&
        String(m.pricing?.prompt ?? "1") === "0" &&
        String(m.pricing?.completion ?? "1") === "0"
      )
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .map(m => m.id);

    if (free.length === 0) throw new Error("No free models returned");

    _cache = free;
    _cacheAt = now;
    console.log(`[models] ${free.length} free models loaded from OpenRouter`);
    return free;
  } catch (err) {
    console.warn(`[models] Live fetch failed (${err.message}), using fallback list`);
    _cache = KNOWN_FREE_MODELS;
    _cacheAt = now;
    return _cache;
  }
}

/**
 * Pick the best free model for a given agent role.
 * Returns the highest-priority model whose id contains a preferred keyword,
 * falling back to the first available free model.
 */
export async function bestModelForRole(role) {
  const models = await getFreeModels();
  const prefs = ROLE_PREFERENCES[role] ?? [];

  for (const keyword of prefs) {
    const match = models.find(id => id.toLowerCase().includes(keyword));
    if (match) return match;
  }

  // Generic fallback: first available free model
  return models[0] ?? KNOWN_FREE_MODELS[0];
}

/**
 * Call OpenRouter trying models in priority order.
 * If the primary model fails (rate limit, unavailable, etc.) it tries the next free model.
 */
export async function callWithFallback({ role, messages, maxAttempts = 3 }) {
  const models = await getFreeModels();
  const prefs = ROLE_PREFERENCES[role] ?? [];

  // Build ranked attempt list: preferred models first, then rest of free list
  const ranked = [];
  for (const keyword of prefs) {
    const match = models.find(id => id.toLowerCase().includes(keyword) && !ranked.includes(id));
    if (match) ranked.push(match);
  }
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
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": process.env.APP_URL ?? "https://mindportalix.app",
          "X-Title": "MindPortalix"
        },
        body: JSON.stringify({ model, messages, temperature: 0.3 })
      });

      if (!res.ok) {
        const body = await res.text();
        // 401 = bad key → no point retrying other models
        if (res.status === 401) {
          throw new Error(`Invalid OpenRouter API key (401). Update OPENROUTER_API_KEY in your .env file. Details: ${body}`);
        }
        // 429/503 = transient → try next model
        lastError = new Error(`${model} failed (${res.status}): ${body}`);
        console.warn(`[models] ${model} failed (${res.status}), trying next…`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      return { content, model };
    } catch (err) {
      // Re-throw auth errors immediately
      if (err.message.includes("401") || err.message.includes("Invalid OpenRouter API key")) {
        throw err;
      }
      lastError = err;
      console.warn(`[models] ${model} threw: ${err.message}, trying next…`);
    }
  }

  throw lastError ?? new Error("All free models failed");
}
