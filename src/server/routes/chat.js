import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { classifyIntent } from "../../orchestration/intent.js";
import {
  runSpecialistAgent,
  reviewDraft,
  parseContent,
  buildExecutorUserMessage,
} from "../../orchestration/responses.js";
import { summarizeForMemory, InMemoryMemoryStore } from "../../storage/memory-store.js";
import { SupabaseMemoryStore } from "../../storage/supabase-store.js";
import { listAgents } from "../../agents/registry.js";
import { getFreeModels } from "../../openrouter/models.js";
import { broadcast } from "../../monitor/broadcaster.js";
import { DEFAULT_CONTEXT_INJECTION } from "./workspace.js";
import { parseArchitectureAgents, applyArchitectureFilter, buildContextInjectionContent } from "../../orchestration/architecture.js";

/** Yield one event-loop tick so SSE writes flush before the next heavy await. */
function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const router = Router();

/** Reviewer target: scores must be strictly greater than this (e.g. 9–10 when value is 8). */
const CHAT_QUALITY_THRESHOLD = 5;
const MAX_PLANNER_QUALITY_ATTEMPTS = 5;

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
  const store = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? new SupabaseMemoryStore(req.token)
    : new InMemoryMemoryStore();
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
  if (res.socket && !res.socket.destroyed) {
    res.socket.setNoDelay(true);
  }

  let closed = false;
  req.on("close", () => { closed = true; });

  function send(event, data) {
    if (closed) return;
    broadcast(event, data);
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(payload, "utf8", () => {
        if (typeof res.flush === "function") res.flush();
      });
    } catch {
      closed = true;
    }
  }

  try {
    send("phase", { stage: "connected", detail: "Connected — classifying intent…" });
    await yieldTick();

    const rawRoute = classifyIntent(message);

    send("pipeline", { detail: "Searching memory…" });
    await yieldTick();

    const memories = await store.search({ userId, query: message }).catch(() => []);

    send("pipeline", {
      detail: memories.length
        ? `Memory ready · ${memories.length} snippet${memories.length === 1 ? "" : "s"}`
        : "Memory ready · no prior context",
    });
    await yieldTick();

    // Load user workspace context (CLAUDE.md, MEMORY.md, architecture, resources, context-injection)
    let workspaceContext = "";
    let contextInjection = DEFAULT_CONTEXT_INJECTION;
    let allowedAgents = null; // null = no architecture restriction
    try {
      const wsRes = await fetch(
        `http://localhost:${process.env.PORT ?? 3000}/api/workspace/context`,
        { headers: { Authorization: req.headers.authorization ?? "" } }
      );
      if (wsRes.ok) {
        const ws = await wsRes.json();
        contextInjection = ws.contextInjection ?? DEFAULT_CONTEXT_INJECTION;

        // Parse architecture — determines which agents are allowed to run
        allowedAgents = parseArchitectureAgents(ws.mermaidDiagram ?? "");

        const parts = [];
        if (ws.claudeMd?.trim()) parts.push(`## Workspace Instructions\n${ws.claudeMd.trim()}`);
        if (ws.memoryMd?.trim())  parts.push(`## User Memory\n${ws.memoryMd.trim()}`);

        // Inject resource file content (text files from 00_Resources/)
        const resourceParts = (ws.resources ?? [])
          .filter(r => r.content?.trim())
          .map(r => `### ${r.name}\n${r.content.trim()}`);
        if (resourceParts.length > 0) {
          parts.push(`## Workspace Resources\n${resourceParts.join("\n\n")}`);
        }

        // Inject enabled context items (skills, rules, agents defs, etc.) from disk
        const injectedCtx = await buildContextInjectionContent(contextInjection);
        if (injectedCtx) parts.push(injectedCtx);

        workspaceContext = parts.join("\n\n");
        send("workspace_context", {
          contextInjection,
          hasClaudeMd: Boolean(ws.claudeMd?.trim()),
          hasMemoryMd: Boolean(ws.memoryMd?.trim()),
          resourceCount: ws.resources?.length ?? 0,
          architectureAgents: allowedAgents ? [...allowedAgents] : null,
        });
        await yieldTick();
      }
    } catch {
      // Non-fatal — proceed without workspace context
    }

    // Apply user's architecture to filter which agents can run
    const route = applyArchitectureFilter(rawRoute, allowedAgents);
    send("route", { agents: routeAgentsForUi(route), primary: route.primary });
    await yieldTick();

    const specialistIds = route.agents.filter(id => id !== "reviewer");

    // Persist user message
    let savedConvId = conversationId ?? null;
    if (store instanceof SupabaseMemoryStore) {
      send("pipeline", { detail: "Saving conversation…" });
      await yieldTick();
      try {
        if (!savedConvId) {
          const convo = await store.createConversation({ userId, title: message.slice(0, 60) });
          if (convo?.id) {
            savedConvId = convo.id;
            send("conversation", { conversationId: savedConvId });
            await yieldTick();
          }
        }
        if (savedConvId) {
          await store.saveMessage({ conversationId: savedConvId, userId, role: "user", content: message });
        }
      } catch (dbErr) {
        console.error("[db] user message save failed:", dbErr.message);
      }
    }

    send("pipeline", { detail: "Calling AI specialists…" });
    await yieldTick();

    // Run specialist agents — stream their output to the collaboration panel
    const specialistResults = [];
    for (const agentId of specialistIds) {
      if (closed) break;
      send("agent_start", { agent: agentId });
      await yieldTick();
      const result = await runSpecialistAgent({
        agentId,
        input: message,
        memories,
        workspaceContext,
        onStreamChunk: (delta) => send("agent_output_delta", { agent: agentId, delta }),
        onStreamReset: () => send("agent_output_reset", { agent: agentId }),
      });
      specialistResults.push(result);
      const detail = buildAgentDetail(result);
      send("agent_detail", detail);
      await yieldTick();
      send("agent_done", { agent: agentId, model: result.model });
      await yieldTick();

      // Immediately forward media results so the client can render them
      if (result.mediaType === "image" && result.mediaUrl) {
        send("media", { mediaType: "image", url: result.mediaUrl, caption: result.content });
      } else if (result.mediaType === "audio" && result.mediaUrl) {
        send("media", { mediaType: "audio", url: result.mediaUrl, caption: result.content });
      }
    }

    if (closed) { res.end(); return; }

    const isMediaOnly =
      specialistResults.length > 0 && specialistResults.every((r) => r.mediaType);

    // Run executor — stream live to BOTH the collaboration panel AND the main chat bubble.
    // A think-tag filter suppresses <think>…</think> reasoning from the main bubble.
    let executorResult = null;
    let executorLiveStreamed = false;

    if (shouldRunExecutor(specialistResults, isMediaOnly) && (!allowedAgents || allowedAgents.has("executor")) && !closed) {
      send("agent_start", { agent: "executor" });
      await yieldTick();
      const executorInput = buildExecutorUserMessage(message, specialistResults);

      let deltaFilter = makeThinkFilter((text) => send("delta", { delta: text }));

      executorResult = await runSpecialistAgent({
        agentId: "executor",
        input: executorInput,
        memories,
        workspaceContext,
        onStreamChunk: (chunk) => {
          send("agent_output_delta", { agent: "executor", delta: chunk });
          deltaFilter.onChunk(chunk);
        },
        onStreamReset: () => {
          // Model switched mid-stream — clear both panels and restart filter
          send("agent_output_reset", { agent: "executor" });
          send("delta_reset", {});
          deltaFilter = makeThinkFilter((text) => send("delta", { delta: text }));
        },
      });

      deltaFilter.flush();
      executorLiveStreamed = true;

      specialistResults.push(executorResult);
      send("agent_detail", buildAgentDetail(executorResult));
      await yieldTick();
      send("agent_done", { agent: "executor", model: executorResult.model });
      await yieldTick();

      // Emit thinking event immediately if reasoning tokens were detected
      const { thinking } = parseContent(executorResult.content ?? "");
      if (thinking) send("thinking", { hidden: true });
    }

    let primaryResult =
      executorResult ??
      specialistResults.find((r) => r.agent === route.primary) ??
      specialistResults[0];

    let review = {
      score: 10,
      passed: true,
      confidence: "high",
      issues: [],
      threshold: CHAT_QUALITY_THRESHOLD,
      lowConfidence: false,
    };

    let persistContent = isMediaOnly
      ? specialistResults.map((r) => r.content).join("\n")
      : parseContent(primaryResult?.content ?? "").answer || primaryResult?.content || "";

    const hasPlanner = specialistIds.includes("planner");

    if (!isMediaOnly) {
      let bestPack = null;
      let chosenPack = null;
      let lowConfidenceOutput = false;

      for (let attempt = 1; attempt <= MAX_PLANNER_QUALITY_ATTEMPTS; attempt++) {
        if (closed) break;

        const snap = buildQualitySnapshot({
          route,
          executorResult,
          specialistResults,
          threshold: CHAT_QUALITY_THRESHOLD,
        });
        const pack = makeQualityPack(snap, specialistResults, executorResult);
        if (!bestPack || pack.review.score > bestPack.review.score) {
          bestPack = pack;
        }

        send("review", {
          score: snap.review.score,
          passed: snap.review.passed,
          confidence: snap.review.confidence,
          threshold: snap.review.threshold,
          issues: snap.review.issues,
          attempt,
          maxAttempts: MAX_PLANNER_QUALITY_ATTEMPTS,
        });
        await yieldTick();

        if (snap.review.score > CHAT_QUALITY_THRESHOLD) {
          chosenPack = pack;
          break;
        }
        if (!hasPlanner) {
          chosenPack = pack;
          break;
        }
        if (attempt === MAX_PLANNER_QUALITY_ATTEMPTS) {
          chosenPack = bestPack;
          lowConfidenceOutput =
            Boolean(bestPack) && bestPack.review.score <= CHAT_QUALITY_THRESHOLD;
          break;
        }

        await replanPlannerAndExecutor({
          message,
          memories,
          workspaceContext,
          specialistIds,
          specialistResults,
          send,
          isClosed: () => closed,
          lastReview: snap.review,
          attempt,
          liveStreamToMain: executorLiveStreamed,
        });
        executorResult = specialistResults.find((r) => r.agent === "executor") ?? null;
      }

      if (!chosenPack) {
        chosenPack =
          bestPack ??
          makeQualityPack(
            buildQualitySnapshot({
              route,
              executorResult,
              specialistResults,
              threshold: CHAT_QUALITY_THRESHOLD,
            }),
            specialistResults,
            executorResult
          );
      }

      specialistResults.length = 0;
      specialistResults.push(...chosenPack.specialistResults);
      executorResult = chosenPack.executorResult;

      // When executor was live-streamed, the main bubble already has the content —
      // skip the fake word-by-word replay entirely.
      if (!executorLiveStreamed) {
        if (chosenPack.thinking) send("thinking", { hidden: true });
        await streamWords(chosenPack.displayContent, (word) => send("delta", { delta: word }));
      }

      review = {
        ...chosenPack.review,
        lowConfidence: lowConfidenceOutput,
      };
      persistContent = chosenPack.persistContent;
      primaryResult = chosenPack.primaryResult;
    }

    // Persist assistant message
    if (store instanceof SupabaseMemoryStore && savedConvId) {
      try {
        await store.saveMessage({
          conversationId: savedConvId,
          userId,
          role: "assistant",
          content: persistContent,
          agent: executorResult ? "executor" : route.primary,
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

/**
 * Filter <think>…</think> reasoning blocks from the live executor stream before
 * forwarding to the main chat bubble. Content inside think tags is suppressed;
 * everything outside is forwarded to sendDelta immediately.
 */
function makeThinkFilter(sendDelta) {
  let buf = "";
  let inThink = false;

  return {
    onChunk(chunk) {
      buf += chunk;
      while (buf.length > 0) {
        if (inThink) {
          const end = buf.indexOf("</think>");
          if (end === -1) {
            // Still inside think block — keep a small tail in case the tag spans chunks
            buf = buf.length > 7 ? buf.slice(-7) : buf;
            return;
          }
          inThink = false;
          buf = buf.slice(end + 8); // 8 = "</think>".length
        } else {
          const start = buf.indexOf("<think>");
          if (start === -1) {
            sendDelta(buf);
            buf = "";
            return;
          }
          if (start > 0) sendDelta(buf.slice(0, start));
          inThink = true;
          buf = buf.slice(start + 7); // 7 = "<think>".length
        }
      }
    },
    flush() {
      if (!inThink && buf) {
        sendDelta(buf);
        buf = "";
      }
    },
  };
}

// Simulate streaming by sending words with a small delay (fallback for non-executor paths)
function streamWords(text, onWord) {
  return new Promise(resolve => {
    const words = text.split(/(\s+)/);
    let i = 0;
    function next() {
      if (i >= words.length) { resolve(); return; }
      onWord(words[i++]);
      setImmediate(next);
    }
    next();
  });
}

export default router;

/** UI route list: show plan executor before reviewer when it will run */
function routeAgentsForUi(route) {
  const agents = [...route.agents];
  if (shouldPreplanExecutor(route) && !agents.includes("executor")) {
    const ri = agents.indexOf("reviewer");
    if (ri >= 0) agents.splice(ri, 0, "executor");
    else agents.push("executor");
  }
  return agents;
}

function shouldPreplanExecutor(route) {
  const specialists = route.agents.filter((a) => a !== "reviewer");
  if (specialists.length === 0) return false;
  if (specialists.includes("planner")) return true;
  return specialists.length >= 2;
}

function shouldRunExecutor(specialistResults, isMediaOnly) {
  if (isMediaOnly) return false;
  const text = specialistResults.filter((r) => !r.mediaType);
  if (text.length === 0) return false;
  if (text.some((r) => r.agent === "planner")) return true;
  return text.length >= 2;
}

function buildAgentDetail(result) {
  const { thinking, answer } = parseContent(result.content);
  return {
    agent: result.agent,
    model: result.model,
    output: answer || result.content,
    hiddenReasoning: Boolean(thinking),
    mediaType: result.mediaType ?? null,
    error: result.error ?? null
  };
}

function rebuildSpecialistsWithPlanner(specialistIds, otherResults, newPlanner) {
  const out = [];
  for (const id of specialistIds) {
    if (id === "planner") out.push(newPlanner);
    else {
      const r = otherResults.find((x) => x.agent === id);
      if (r) out.push(r);
    }
  }
  return out;
}

function buildQualitySnapshot({ route, executorResult, specialistResults, threshold }) {
  const primaryResult =
    executorResult ??
    specialistResults.find((r) => r.agent === route.primary) ??
    specialistResults[0];
  const finalContent = primaryResult?.content ?? "I could not generate a response.";
  const { thinking, answer } = parseContent(finalContent);
  const displayContent = answer || finalContent;
  const review = reviewDraft({ draft: displayContent, route, threshold });
  const persistContent = answer || finalContent;
  return {
    primaryResult,
    finalContent,
    thinking,
    displayContent,
    persistContent,
    review,
  };
}

function makeQualityPack(snap, specialistResults, executorResult) {
  return {
    ...snap,
    specialistResults: [...specialistResults],
    executorResult,
  };
}

async function replanPlannerAndExecutor({
  message,
  memories,
  workspaceContext = "",
  specialistIds,
  specialistResults,
  send,
  isClosed,
  lastReview,
  attempt,
  liveStreamToMain = false,
}) {
  const otherResults = specialistResults.filter(
    (r) => r.agent !== "planner" && r.agent !== "executor"
  );
  const feedback = [
    `The reviewer scored the last assistant reply ${lastReview.score}/10 (target: strictly above ${CHAT_QUALITY_THRESHOLD}).`,
    lastReview.issues.length
      ? `Issues: ${lastReview.issues.join("; ")}.`
      : "Improve depth and usefulness.",
    "Produce a revised Markdown work plan only—clearer steps, dependencies, and milestones.",
  ].join(" ");

  const plannerInput = `${message}\n\n---\nREVISION REQUEST (attempt ${attempt + 1})\n${feedback}`;

  if (isClosed()) return;

  send("agent_start", { agent: "planner", replan: true, attempt: attempt + 1 });
  send("agent_output_reset", { agent: "planner" });
  await yieldTick();

  const newPlanner = await runSpecialistAgent({
    agentId: "planner",
    input: plannerInput,
    memories,
    workspaceContext,
    onStreamChunk: (delta) => send("agent_output_delta", { agent: "planner", delta }),
    onStreamReset: () => send("agent_output_reset", { agent: "planner" }),
  });

  const rebuilt = rebuildSpecialistsWithPlanner(specialistIds, otherResults, newPlanner);
  specialistResults.length = 0;
  specialistResults.push(...rebuilt);

  send("agent_detail", buildAgentDetail(newPlanner));
  await yieldTick();
  send("agent_done", { agent: "planner", model: newPlanner.model });
  await yieldTick();

  if (isClosed()) return;

  send("agent_start", { agent: "executor", replan: true, attempt: attempt + 1 });
  send("agent_output_reset", { agent: "executor" });
  await yieldTick();

  // Reset the main bubble before re-streaming the revised answer
  if (liveStreamToMain) {
    send("delta_reset", {});
  }

  const executorInput = buildExecutorUserMessage(message, specialistResults);

  let deltaFilter = liveStreamToMain
    ? makeThinkFilter((text) => send("delta", { delta: text }))
    : null;

  const newExec = await runSpecialistAgent({
    agentId: "executor",
    input: executorInput,
    memories,
    workspaceContext,
    onStreamChunk: (chunk) => {
      send("agent_output_delta", { agent: "executor", delta: chunk });
      if (deltaFilter) deltaFilter.onChunk(chunk);
    },
    onStreamReset: () => {
      send("agent_output_reset", { agent: "executor" });
      if (liveStreamToMain) {
        send("delta_reset", {});
        deltaFilter = makeThinkFilter((text) => send("delta", { delta: text }));
      }
    },
  });

  if (deltaFilter) deltaFilter.flush();

  specialistResults.push(newExec);
  send("agent_detail", buildAgentDetail(newExec));
  await yieldTick();
  send("agent_done", { agent: "executor", model: newExec.model });
  await yieldTick();

  if (liveStreamToMain) {
    const { thinking } = parseContent(newExec.content ?? "");
    if (thinking) send("thinking", { hidden: true });
  }
}
