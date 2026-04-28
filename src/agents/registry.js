export const AGENT_REGISTRY = Object.freeze({
  orchestrator: {
    id: "orchestrator",
    name: "Orchestrator",
    model: "mistralai/mistral-7b-instruct",
    responsibilities: [
      "Classify user intent",
      "Select specialist agents",
      "Assemble reviewed final responses"
    ],
    keywords: []
  },
  researcher: {
    id: "researcher",
    name: "Researcher",
    model: "google/gemma-3-8b-it",
    responsibilities: [
      "Ground current or factual claims",
      "Summarize retrieved context",
      "Return citations when sources are available"
    ],
    keywords: ["research", "source", "sources", "current", "latest", "cite", "citation", "fact", "news"]
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    model: "qwen/qwen-2.5-7b-instruct",
    responsibilities: [
      "Score draft responses",
      "Flag missing context",
      "Request retries when quality is too low"
    ],
    keywords: ["review", "critique", "score", "quality", "validate", "check"]
  },
  memory: {
    id: "memory",
    name: "Memory",
    model: "meta-llama/llama-3.1-8b-instruct",
    responsibilities: [
      "Retrieve relevant user context",
      "Compress session summaries",
      "Tag memory by topic and importance"
    ],
    keywords: ["remember", "memory", "preference", "context", "profile"]
  },
  coder: {
    id: "coder",
    name: "Coder",
    model: "microsoft/phi-3-mini-128k-instruct",
    responsibilities: ["Generate code", "Debug failures", "Review implementation details"],
    keywords: ["code", "bug", "debug", "test", "implement", "refactor", "api", "database"]
  },
  writer: {
    id: "writer",
    name: "Writer",
    model: "google/gemma-3-8b-it",
    responsibilities: ["Draft long-form content", "Summarize text", "Adapt tone and format"],
    keywords: ["write", "draft", "email", "essay", "summary", "summarize", "copy"]
  },
  governor: {
    id: "governor",
    name: "Governor",
    model: "qwen/qwen-2.5-7b-instruct",
    responsibilities: ["Detect sensitive data", "Enforce safety rules", "Block unsafe actions"],
    keywords: ["safety", "policy", "pii", "secret", "credentials", "harmful", "private"]
  },
  planner: {
    id: "planner",
    name: "Planner",
    model: "mistralai/mistral-7b-instruct",
    responsibilities: ["Break work into milestones", "Sequence tasks", "Identify dependencies"],
    keywords: ["plan", "roadmap", "timeline", "milestone", "strategy", "steps"]
  },
  formatter: {
    id: "formatter",
    name: "Formatter",
    model: "microsoft/phi-3-mini-128k-instruct",
    responsibilities: ["Render Markdown", "Produce JSON or tables", "Normalize final output"],
    keywords: ["format", "markdown", "json", "table", "render", "template"]
  },
  image_generator: {
    id: "image_generator",
    name: "Image Generator",
    model: "black-forest-labs/flux-1-schnell:free",
    modality: "image",
    responsibilities: ["Generate images from text prompts", "Create visual content", "Illustrate concepts"],
    keywords: [
      "generate image", "create image", "draw", "illustrate", "render image",
      "image of", "picture of", "text to image", "dalle", "stable diffusion",
      "flux", "paint", "sketch", "artwork", "visualize", "logo", "icon",
      "banner", "thumbnail", "mockup", "portrait", "landscape"
    ]
  },
  audio_generator: {
    id: "audio_generator",
    name: "Audio Generator",
    model: "google/lyria-3-pro-preview",
    modality: "audio",
    responsibilities: ["Generate music from text prompts", "Convert text to speech", "Create audio content"],
    keywords: [
      "generate audio", "create audio", "generate music", "compose music",
      "text to speech", "tts", "voice over", "narrate", "sing", "song",
      "sound effect", "audio clip", "podcast", "speech", "melody", "tune",
      "beat", "track", "jingle", "ringtone", "read aloud"
    ]
  }
});

export function getAgent(agentId) {
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  return agent;
}

export function listAgents() {
  return Object.values(AGENT_REGISTRY);
}
