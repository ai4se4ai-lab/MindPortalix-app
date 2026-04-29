/**
 * OpenRouter media generation helpers.
 *
 * Handles image and audio generation via OpenRouter's API.
 * OpenRouter exposes:
 *   • /images/generations  — OpenAI-compatible image generation
 *   • /audio/speech        — OpenAI-compatible TTS
 *   • /chat/completions    — used for music-generation models (Lyria, etc.)
 */

const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

const AUTH_HEADERS = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  "HTTP-Referer": process.env.APP_URL ?? "https://mindportalix.app",
  "X-Title": "MindPortalix",
});

// ── Image generation ───────────────────────────────────────────────────────

/**
 * Generate an image from a text prompt.
 * Uses OpenRouter's /images/generations endpoint (OpenAI-compatible).
 * Falls back to chat completions if that endpoint fails.
 *
 * @returns {{ url: string, model: string }}
 */
export async function generateImage({ prompt, model }) {
  // 1. Try /images/generations (preferred)
  try {
    const res = await fetch(`${BASE_URL()}/images/generations`, {
      method: "POST",
      headers: AUTH_HEADERS(),
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        response_format: "url",
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const url = data.data?.[0]?.url ?? data.data?.[0]?.b64_json;
      if (url) return { url: url.startsWith("data:") ? url : url, model };
    }
    // Non-200 falls through to chat completions fallback
    console.warn(`[media] /images/generations → ${res.status}, trying chat completions…`);
  } catch (err) {
    console.warn(`[media] /images/generations threw: ${err.message}, trying chat completions…`);
  }

  // 2. Fallback: some image models respond via chat completions with a markdown image
  const chatRes = await fetch(`${BASE_URL()}/chat/completions`, {
    method: "POST",
    headers: AUTH_HEADERS(),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `Generate an image: ${prompt}` }],
    }),
  });

  if (!chatRes.ok) {
    const body = await chatRes.text();
    throw new Error(`Image generation failed (${chatRes.status}): ${body}`);
  }

  const chatData = await chatRes.json();
  const content = chatData.choices?.[0]?.message?.content ?? "";

  // Extract URL from markdown ![alt](url) or plain URL
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
  const plainMatch = content.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif)[^\s]*)/i);
  const url = mdMatch?.[1] ?? plainMatch?.[1];

  if (!url) throw new Error("Image model returned no URL in its response.");
  return { url, model };
}

// ── Audio / TTS generation ─────────────────────────────────────────────────

/**
 * Convert text to speech via OpenRouter's /audio/speech endpoint.
 * Returns a base64 data URI (audio/mpeg) that can be used in <audio src>.
 *
 * @returns {{ dataUri: string, model: string }}
 */
export async function generateSpeech({ text, model, voice = "alloy" }) {
  const res = await fetch(`${BASE_URL()}/audio/speech`, {
    method: "POST",
    headers: AUTH_HEADERS(),
    body: JSON.stringify({ model, input: text, voice }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TTS failed (${res.status}): ${body}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { dataUri: `data:audio/mpeg;base64,${base64}`, model };
}

/**
 * Generate music / audio via chat completions (e.g. Google Lyria).
 * Returns a URL to the generated audio file as provided by the model.
 *
 * @returns {{ url: string, model: string }}
 */
export async function generateMusic({ prompt, model }) {
  const res = await fetch(`${BASE_URL()}/chat/completions`, {
    method: "POST",
    headers: AUTH_HEADERS(),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Music generation failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";

  // Extract audio URL from content (model returns a link)
  const urlMatch = content.match(/(https?:\/\/[^\s]+\.(mp3|wav|ogg|flac|m4a|aac)[^\s]*)/i)
    ?? content.match(/(https?:\/\/[^\s"<>]+audio[^\s"<>]*)/i);

  if (urlMatch) return { url: urlMatch[1], model };

  // Some models return base64 or raw data URIs
  const dataUriMatch = content.match(/(data:audio\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
  if (dataUriMatch) return { url: dataUriMatch[1], model };

  // Could not extract media — return a text description as fallback
  throw new Error(`Audio model returned no URL. Response: ${content.slice(0, 200)}`);
}
