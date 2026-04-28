import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { classifyIntent } from "../../orchestration/intent.js";
import { runSpecialistAgent, reviewDraft } from "../../orchestration/responses.js";
import { summarizeForMemory } from "../../storage/memory-store.js";
import { SupabaseMemoryStore } from "../../storage/supabase-store.js";
import { InMemoryMemoryStore } from "../../storage/memory-store.js";
import { listAgents } from "../../agents/registry.js";

const router = Router();
const store = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new SupabaseMemoryStore()
  : new InMemoryMemoryStore();

router.get("/agents", (_req, res) => {
  res.json({ agents: listAgents() });
});

router.post("/", requireAuth, async (req, res) => {
  const { message, conversationId, stream: wantStream = true } = req.body;
  const userId = req.user.id;

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const route = classifyIntent(message);
  const memories = await store.search({ userId, query: message }).catch(() => []);
  const specialistIds = route.agents.filter((id) => id !== "reviewer");

  if (wantStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("route", { agents: route.agents, primary: route.primary });

    try {
      let savedConversationId = conversationId;
      if (store instanceof SupabaseMemoryStore) {
        if (!savedConversationId) {
          const convo = await store.createConversation({
            userId,
            title: message.slice(0, 60)
          });
          savedConversationId = convo.id;
          send("conversation", { conversationId: savedConversationId });
        }
        await store.saveMessage({
          conversationId: savedConversationId,
          userId,
          role: "user",
          content: message
        });
      }

      const specialistResults = [];
      for (const agentId of specialistIds) {
        send("agent_start", { agent: agentId });
        let agentContent = "";
        const result = await runSpecialistAgent({
          agentId,
          input: message,
          memories,
          stream: agentId === route.primary,
          onChunk: agentId === route.primary
            ? (delta) => {
                agentContent += delta;
                send("delta", { agent: agentId, delta });
              }
            : undefined
        });
        specialistResults.push(result);
        send("agent_done", { agent: agentId, model: result.model });
      }

      const primaryResult = specialistResults.find((r) => r.agent === route.primary)
        ?? specialistResults[0];
      const finalContent = primaryResult?.content ?? "I could not generate a response.";

      const review = reviewDraft({
        draft: finalContent,
        route,
        threshold: 7
      });

      send("review", { score: review.score, passed: review.passed, confidence: review.confidence });

      if (store instanceof SupabaseMemoryStore && savedConversationId) {
        await store.saveMessage({
          conversationId: savedConversationId,
          userId,
          role: "assistant",
          content: finalContent,
          agent: route.primary,
          model: primaryResult?.model,
          score: review.score
        });
      }

      await store.write(
        summarizeForMemory({
          userId,
          topic: route.primary,
          messages: [
            { role: "user", content: message },
            { role: "assistant", content: finalContent }
          ],
          importance: 3
        })
      ).catch(() => null);

      send("done", {
        conversationId: savedConversationId,
        route,
        review,
        modelPlan: specialistResults.map(({ agent, model }) => ({ agent, model }))
      });
    } catch (err) {
      send("error", { message: err.message });
    } finally {
      res.end();
    }
  } else {
    try {
      const specialistResults = await Promise.all(
        specialistIds.map((agentId) => runSpecialistAgent({ agentId, input: message, memories }))
      );
      const primaryResult = specialistResults.find((r) => r.agent === route.primary) ?? specialistResults[0];
      const finalContent = primaryResult?.content ?? "No response generated.";
      const review = reviewDraft({ draft: finalContent, route });

      res.json({
        route,
        content: finalContent,
        review,
        memories: memories.length,
        modelPlan: specialistResults.map(({ agent, model }) => ({ agent, model }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;
