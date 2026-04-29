/**
 * Modality detection for MindPortalix.
 *
 * Analyses user input and returns the set of OUTPUT modalities the task requires.
 * 'text' is always present (for reasoning / orchestration).
 * Additional modalities are added when the user clearly wants media output.
 */

export const MODALITY = Object.freeze({
  TEXT:  "text",
  IMAGE: "image",
  AUDIO: "audio",
});

// ── Signal patterns ────────────────────────────────────────────────────────

const AUDIO_SIGNALS = [
  // explicit generation intent + audio noun
  /\b(generate|create|make|produce|compose|record|write)\s+(a\s+|an\s+|some\s+)?(audio|music|song|sound|voice\s*over|speech|melody|tune|beat|track|jingle|ringtone|podcast)\b/i,
  // text-to-speech shorthands
  /\btext[- ]to[- ]speech\b/i,
  /\b(tts|voiceover)\b/i,
  // music composition
  /\bcompose\s+(a\s+|some\s+)?music\b/i,
  /\bsing\s+(me\s+)?(a\s+)?song\b/i,
  // audio file requests
  /\b(make|create|generate)\s+(an?\s+)?audio\s+(clip|file|track)\b/i,
  /\bsound\s+effect\b/i,
  // narration / read-aloud
  /\bnarrat(e|ing|ion)\b/i,
  /\bread.*aloud\b/i,
  /\bspeak.*this\b/i,
  /\bconvert.*to.*speech\b/i,
];

const IMAGE_SIGNALS = [
  // explicit generation intent + image noun
  /\b(generate|create|make|draw|render|illustrate|design|paint|sketch|show me)\s+(me\s+)?(a\s+|an\s+|the\s+)?(image|picture|photo|illustration|artwork|painting|drawing|portrait|landscape|visual|logo|icon|banner|thumbnail|wallpaper|mockup)\b/i,
  // text-to-image shorthands
  /\btext[- ]to[- ]image\b/i,
  // "image of" / "picture of"
  /\b(image|picture|photo|illustration)\s+of\b/i,
  // short imperative
  /\bdraw\s+me\b/i,
  /\bvisuali[sz]e\b/i,
  /\bgenerate\s+(an?\s+)?art(work)?\b/i,
  // stable diffusion / DALL-E mentions
  /\b(dall[- ]?e|stable\s+diffusion|midjourney|flux)\b/i,
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect which output modalities a user request requires.
 * @param {string} input - raw user message
 * @returns {string[]} array of MODALITY values, always includes MODALITY.TEXT
 */
export function detectModalities(input) {
  const mods = new Set([MODALITY.TEXT]);

  if (AUDIO_SIGNALS.some(p => p.test(input))) mods.add(MODALITY.AUDIO);
  if (IMAGE_SIGNALS.some(p => p.test(input))) mods.add(MODALITY.IMAGE);

  return [...mods];
}

/**
 * Describe the modality set in human-readable form.
 * Used in UI labels.
 */
export function modalityLabel(modalities) {
  const set = new Set(modalities);
  if (set.has(MODALITY.AUDIO) && set.has(MODALITY.IMAGE)) return "text + image + audio";
  if (set.has(MODALITY.AUDIO)) return "text + audio";
  if (set.has(MODALITY.IMAGE)) return "text + image";
  return "text";
}
