/**
 * Workspace routes — HTTP adapter layer.
 *
 * All business logic lives in the service layer (src/services/).
 * These route handlers are intentionally thin: auth → validate → delegate → respond.
 *
 * Test-hook exports (_setSupabaseFactory, _resetSupabaseFactory, DEFAULT_MERMAID,
 * DEFAULT_CONTEXT_INJECTION) are re-exported here for backward compatibility with the
 * existing test suite that imports them from this path.
 */
import { Router } from "express";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../middleware/auth.js";
import { getClient, setClientFactory, resetClientFactory } from "../../lib/supabase-client.js";
import * as wsService from "../../services/user/ws-service.js";
import * as coService from "../../services/user/co-service.js";

const router = Router();
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Re-export defaults so existing tests keep working ────────────────────────
export { DEFAULT_MERMAID, DEFAULT_CONTEXT_INJECTION } from "../../lib/defaults.js";

// ── Re-export test hooks so existing tests keep working ──────────────────────
export function _setSupabaseFactory(fn) { setClientFactory(fn); }
export function _resetSupabaseFactory()  { resetClientFactory(); }

// ── Workspace init ───────────────────────────────────────────────────────────

router.post("/init", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.json({ status: "no-db" });
  try {
    await wsService.initWorkspace(sb, req.user.id);
    res.json({ status: "ok" });
  } catch (err) {
    console.error("[workspace/init]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Agent config ─────────────────────────────────────────────────────────────

router.get("/agent-config", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.json({ mermaid_diagram: (await import("../../lib/defaults.js")).DEFAULT_MERMAID, agent_overrides: {} });
  try {
    const data = await wsService.getAgentConfig(sb, req.user.id);
    res.json({ mermaid_diagram: data.mermaid_diagram, agent_overrides: data.agent_overrides });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/agent-config", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  try {
    await wsService.upsertAgentConfig(sb, req.user.id, req.body);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Context injection ────────────────────────────────────────────────────────

router.get("/context-injection", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.json({ rules: (await import("../../lib/defaults.js")).DEFAULT_CONTEXT_INJECTION });
  try {
    const data = await wsService.getContextInjection(sb, req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/context-injection", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  try {
    await wsService.upsertContextInjection(sb, req.user.id, req.body.rules);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace files ──────────────────────────────────────────────────────────

router.get("/files", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.json({ files: [] });
  try {
    const files = await wsService.getFiles(sb, req.user.id);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/files/*", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  try {
    const data = await wsService.getFile(sb, req.user.id, req.params[0]);
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/files/*", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  try {
    await wsService.upsertFile(sb, req.user.id, req.params[0], req.body);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/files/*", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  const filePath = req.params[0];
  const fileName = filePath.split("/").pop();
  if (["CLAUDE.md", "MEMORY.md", "00_Resources"].includes(fileName)) {
    return res.status(403).json({ error: "Cannot delete protected workspace items" });
  }
  try {
    await wsService.deleteFile(sb, req.user.id, filePath);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File upload ──────────────────────────────────────────────────────────────

router.post("/upload", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  const { name, content, mime_type, directory } = req.body;
  if (!name || !content) return res.status(400).json({ error: "name and content required" });
  try {
    const path = await wsService.uploadFile(sb, req.user.id, { name, content, mime_type, directory });
    res.json({ status: "ok", path });
  } catch (err) {
    const status = err.message.startsWith("Only") ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Create workstation (directory) ───────────────────────────────────────────

router.post("/directories", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });
  const rawName = (req.body.name ?? "").trim();
  if (!rawName) return res.status(400).json({ error: "name required" });
  const safeName = rawName.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  if (!safeName) return res.status(400).json({ error: "Invalid directory name" });
  try {
    const path = await wsService.createDirectory(sb, req.user.id, safeName);
    res.json({ status: "ok", path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace context (CO-mediated read) ─────────────────────────────────────

router.get("/context", requireAuth, async (req, res) => {
  const sb = getClient(req.token);
  try {
    const data = await coService.getContext(sb, req.user.id);
    res.json(data);
  } catch (err) {
    console.error("[workspace/context]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Server-side defaults (read-only, never written by users) ─────────────────

router.get("/defaults/:ruleId/:item", requireAuth, async (req, res) => {
  const { ruleId, item } = req.params;
  if (!/^[a-z_-]+$/.test(ruleId) || !/^[a-zA-Z0-9_.:-]+$/.test(item)) {
    return res.status(400).json({ error: "Invalid path" });
  }
  for (const name of [`${item}.md`, `${item}.js`, item]) {
    try {
      const content = await readFile(join(PROJECT_ROOT, ruleId, name), "utf8");
      return res.json({ content });
    } catch {}
  }
  res.json({ content: "" });
});

export default router;
