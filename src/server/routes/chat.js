import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { classifyIntent } from "../../orchestration/intent.js";
import { runSpecialistAgent, reviewDraft, parseContent } from "../../orchestration/responses.js";
import { summarizeForMemory, InMemoryMemoryStore } from "../../storage/memory-store.js";
import { SupabaseMemoryStore } from "../../storage/supabase-store.js";
import { listAgents } from "../../agents/registry.js";
import { getFreeModels } from "../../openrouter/models.js";

const router = Router();
const store = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new SupabaseMemoryStore()
  : new InMemoryMemoryStore();

router.get("/agents", (_req, res) => {
  res.json({ agents: listAgents() });
});

router.get("/models", async (_req, res) => {
  try {
    const models = await getFreeModels();
    res.json({ models, count: models.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAuth, async (req, res) => {
  const { message, conversationId } = req.body;
  const userId = req.user.id;

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => { closed = true; });

  function send(event, data) {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  }

  try {
    const route = classifyIntent(message);
    send("route", { agents: route.agents, primary: route.primary });

    const memories = await store.search({ userId, query: message }).catch(() => []);
    const specialistIds = route.agents.filter(id => id !== "reviewer");

    // Persist user message
    let savedConvId = conversationId ?? null;
    if (store instanceof SupabaseMemoryStore) {
      try {
        if (!savedConvId) {
          const convo = await store.createConversation({ userId, title: message.slice(0, 60) });
          if (convo?.id) {
            savedConvId = convo.id;
            send("conversation", { conversationId: savedConvId });
          }
        }
        if (savedConvId) {
          await store.saveMessage({ conversationId: savedConvId, userId, role: "user", content: message });
        }
      } catch (dbErr) {
        console.error("[db] user message save failed:", dbErr.message);
      }
    }

    // Call specialist agents (non-streaming to OpenRouter — reliable)
    const specialistResults = [];
    for (const agentId of specialistIds) {
      if (closed) break;
      send("agent_start", { agent: agentId });
      const result = await runSpecialistAgent({ agentId, input: message, memories });
      specialistResults.push(result);
      send("agent_done", { agent: agentId, model: result.model });

      // Immediately forward media results so the client can render them
      if (result.mediaType === "image" && result.mediaUrl) {
        send("media", { mediaType: "image", url: result.mediaUrl, caption: result.content });
      } else if (result.mediaType === "audio" && result.mediaUrl) {
        send("media", { mediaType: "audio", url: result.mediaUrl, caption: result.content });
      }
    }

    if (closed) { res.end(); return; }

    const primaryResult = specialistResults.find(r => r.agent === route.primary)
      ?? specialistResults[0];
    const finalContent = primaryResult?.content ?? "I could not generate a response.";

    // For pure media responses skip the text stream entirely
    const isMediaOnly = specialistResults.every(r => r.mediaType);

    // review is used both inside the block and in the `done` event — hoist it
    let review = { score: 10, passed: true, confidence: "high", issues: [] };

    if (!isMediaOnly) {
      // Split thinking / chain-of-thought from the actual answer
      const { thinking, answer } = parseContent(finalContent);
      if (thinking) send("thinking", { thinking });
      const displayContent = answer || finalContent;

      review = reviewDraft({ draft: displayContent, route });
      send("review", { score: review.score, passed: review.passed, confidence: review.confidence });

      // Stream the clean answer word-by-word for typewriter UX
      await streamWords(displayContent, word => send("delta", { delta: word }));
    }

    // Build the canonical text to persist (media agents use their caption)
    const persistContent = isMediaOnly
      ? specialistResults.map(r => r.content).join("\n")
      : (parseContent(finalContent).answer || finalContent);

    // Persist assistant message
    if (store instanceof SupabaseMemoryStore && savedConvId) {
      try {
        await store.saveMessage({
          conversationId: savedConvId,
          userId,
          role: "assistant",
          content: persistContent,
          agent: route.primary,
          model: primaryResult?.model,
        });
      } catch (dbErr) {
        console.error("[db] assistant message save failed:", dbErr.message);
      }
    }

    // Write memory summary (best-effort)
    store.write(
      summarizeForMemory({
        userId,
        topic: route.primary,
        messages: [
          { role: "user", content: message },
          { role: "assistant", content: persistContent }
        ],
        importance: 3
      })
    ).catch(() => null);

    send("done", {
      conversationId: savedConvId,
      route,
      review,
      modelPlan: specialistResults.map(({ agent, model }) => ({ agent, model }))
    });
  } catch (err) {
    console.error("[chat] error:", err.message);
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

// Simulate streaming by sending words with a small delay
function streamWords(text, onWord) {
  return new Promise(resolve => {
    const words = text.split(/(\s+)/);
    let i = 0;
    function next() {
      if (i >= words.length) { resolve(); return; }
      onWord(words[i++]);
      // ~30ms per token gives ~33 tokens/sec typewriter feel
      setImmediate(next);
    }
    next();
  });
}

export default router;
