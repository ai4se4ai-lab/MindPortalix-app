import { Router } from "express";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../middleware/auth.js";
import { createClient } from "@supabase/supabase-js";

const router = Router();
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_MERMAID = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> researcher
  orchestrator --> memory
  orchestrator --> coder
  orchestrator --> writer
  orchestrator --> governor
  orchestrator --> planner
  orchestrator --> formatter
  orchestrator --> imagegen["Image Gen"]
  orchestrator --> audiogen["Audio Gen"]
  researcher --> executor
  memory --> executor
  coder --> executor
  writer --> executor
  planner --> executor
  formatter --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

export const DEFAULT_CONTEXT_INJECTION = [
  { id: "skills",  label: "Skills",  items: ["agent-orchestration","memory-compression","model-selection","openrouter","prompt-engineering","supabase-auth"], active: true },
  { id: "agents",  label: "Agents",  items: ["orchestrator","researcher","reviewer","memory","coder","writer","governor","planner","executor","formatter","image_generator","audio_generator"], active: true },
  { id: "rules",   label: "Rules",   items: ["api-design","general","styling","supabase","testing"], active: true },
  { id: "mcps",    label: "MCPs",    items: ["github","supabase"], active: true },
  { id: "hooks",   label: "Hooks",   items: ["on-agent-complete","on-error","on-memory-write","post-tool-use","pre-tool-use"], active: true },
  { id: "memory",  label: "Memory",  items: ["MEMORY.md"], active: true },
];

const DEFAULT_CLAUDE_MD = `# My Workspace

This is your personal MindPortalix workspace. Add context and instructions for the AI agents here.

## Instructions
- Add your preferences, goals, and important context here
- Reference files in 00_Resources/ for the agents to use
- Create workstations (directories) for different projects

## Preferences
- (Add your preferences here)
`;

const DEFAULT_MEMORY_MD = `# Memory

This file stores important context about your preferences, ongoing projects, and key information.

## About Me
- (Add information about yourself here)

## Active Projects
- (Add your current projects here)

## Key Notes
- (Add important notes here)
`;

// ── Supabase helper ──────────────────────────────────────────────────────────

function isSecretPlaceholder(v) {
  return !v || v.includes("your-key") || v === "undefined";
}

function getSupabase(accessToken) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY ?? "";
  const usingPublishable = isSecretPlaceholder(secret);
  const key = usingPublishable
    ? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    : secret;
  if (!url || !key) return null;
  const opts = { auth: { persistSession: false } };
  if (usingPublishable && accessToken) {
    opts.global = { headers: { Authorization: `Bearer ${accessToken}` } };
  }
  return createClient(url, key, opts);
}

// ── Test-only injection hook (never called in production) ────────────────────
let _testClientFactory = null;
export function _setSupabaseFactory(fn) { _testClientFactory = fn; }
export function _resetSupabaseFactory()  { _testClientFactory = null; }
function _getClient(t) { return _testClientFactory ? _testClientFactory(t) : getSupabase(t); }

// ── Workspace init ───────────────────────────────────────────────────────────

router.post("/init", requireAuth, async (req, res) => {
  const { id: userId } = req.user;
  const sb = _getClient(req.token);
  if (!sb) return res.json({ status: "no-db" });

  try {
    await Promise.all([
      sb.from("user_agent_configs").upsert(
        { user_id: userId, mermaid_diagram: DEFAULT_MERMAID, agent_overrides: {} },
        { onConflict: "user_id", ignoreDuplicates: true }
      ),
      sb.from("user_context_injection").upsert(
        { user_id: userId, rules: DEFAULT_CONTEXT_INJECTION },
        { onConflict: "user_id", ignoreDuplicates: true }
      ),
      ...[
        { path: "CLAUDE.md",    name: "CLAUDE.md",    content: DEFAULT_CLAUDE_MD,  mime_type: "text/markdown",     is_directory: false },
        { path: "MEMORY.md",    name: "MEMORY.md",    content: DEFAULT_MEMORY_MD,  mime_type: "text/markdown",     is_directory: false },
        { path: "00_Resources", name: "00_Resources", content: null,               mime_type: null,                is_directory: true  },
      ].map(f =>
        sb.from("workspace_files").upsert(
          { user_id: userId, ...f, size_bytes: f.content ? f.content.length : 0 },
          { onConflict: "user_id,path", ignoreDuplicates: true }
        )
      ),
    ]);
    res.json({ status: "ok" });
  } catch (err) {
    console.error("[workspace/init]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Agent config ─────────────────────────────────────────────────────────────

router.get("/agent-config", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.json({ mermaid_diagram: DEFAULT_MERMAID, agent_overrides: {} });

  const { data } = await sb.from("user_agent_configs")
    .select("mermaid_diagram, agent_overrides")
    .eq("user_id", req.user.id)
    .single();

  res.json(data ?? { mermaid_diagram: DEFAULT_MERMAID, agent_overrides: {} });
});

router.put("/agent-config", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const { mermaid_diagram, agent_overrides } = req.body;
  const { error } = await sb.from("user_agent_configs").upsert(
    { user_id: req.user.id, mermaid_diagram, agent_overrides: agent_overrides ?? {}, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "ok" });
});

// ── Context injection ────────────────────────────────────────────────────────

router.get("/context-injection", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.json({ rules: DEFAULT_CONTEXT_INJECTION });

  const { data } = await sb.from("user_context_injection")
    .select("rules")
    .eq("user_id", req.user.id)
    .single();

  res.json({ rules: data?.rules ?? DEFAULT_CONTEXT_INJECTION });
});

router.put("/context-injection", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const { rules } = req.body;
  const { error } = await sb.from("user_context_injection").upsert(
    { user_id: req.user.id, rules, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "ok" });
});

// ── Workspace files ──────────────────────────────────────────────────────────

router.get("/files", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.json({ files: [] });

  const { data, error } = await sb.from("workspace_files")
    .select("id, path, name, mime_type, size_bytes, is_directory, created_at, updated_at")
    .eq("user_id", req.user.id)
    .not("path", "like", "_context/%")
    .order("path");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ files: data ?? [] });
});

router.get("/files/*", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const filePath = req.params[0];
  const { data, error } = await sb.from("workspace_files")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("path", filePath)
    .single();
  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.put("/files/*", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const filePath = req.params[0];
  const { content, mime_type } = req.body;
  const name = filePath.split("/").pop();

  const { error } = await sb.from("workspace_files").upsert(
    {
      user_id: req.user.id,
      path: filePath,
      name,
      content: content ?? "",
      mime_type: mime_type ?? "text/plain",
      size_bytes: content ? content.length : 0,
      is_directory: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,path" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "ok" });
});

router.delete("/files/*", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const filePath = req.params[0];
  const fileName = filePath.split("/").pop();
  if (["CLAUDE.md", "MEMORY.md", "00_Resources"].includes(fileName)) {
    return res.status(403).json({ error: "Cannot delete protected workspace items" });
  }

  // Delete the item itself and (if directory) all descendants
  const [r1, r2] = await Promise.all([
    sb.from("workspace_files").delete().eq("user_id", req.user.id).eq("path", filePath),
    sb.from("workspace_files").delete().eq("user_id", req.user.id).like("path", `${filePath}/%`),
  ]);
  const err = r1.error ?? r2.error;
  if (err) return res.status(500).json({ error: err.message });
  res.json({ status: "ok" });
});

// ── File upload ──────────────────────────────────────────────────────────────

router.post("/upload", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const { name, content, mime_type, directory } = req.body;
  if (!name || !content) return res.status(400).json({ error: "name and content required" });

  const ext = name.split(".").pop()?.toLowerCase();
  if (!["md", "pdf", "csv", "txt"].includes(ext)) {
    return res.status(400).json({ error: "Only .md, .pdf, .csv, .txt files are allowed" });
  }

  const dir = directory ?? "00_Resources";
  const filePath = `${dir}/${name}`;

  const { error } = await sb.from("workspace_files").upsert(
    {
      user_id: req.user.id,
      path: filePath,
      name,
      content,
      mime_type: mime_type ?? "application/octet-stream",
      size_bytes: content.length,
      is_directory: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,path" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ status: "ok", path: filePath });
});

// ── Create workstation (directory) ───────────────────────────────────────────

router.post("/directories", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const rawName = (req.body.name ?? "").trim();
  if (!rawName) return res.status(400).json({ error: "name required" });

  const safeName = rawName.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  if (!safeName) return res.status(400).json({ error: "Invalid directory name" });

  const uid = req.user.id;
  const now = new Date().toISOString();
  const uo  = { onConflict: "user_id,path", ignoreDuplicates: true };

  const results = await Promise.all([
    // The workstation directory itself
    sb.from("workspace_files").upsert(
      { user_id: uid, path: safeName, name: safeName, content: null, mime_type: null, size_bytes: 0, is_directory: true, updated_at: now }, uo
    ),
    // Default files inside the workstation
    sb.from("workspace_files").upsert(
      { user_id: uid, path: `${safeName}/CLAUDE.md`,  name: "CLAUDE.md",  content: DEFAULT_CLAUDE_MD,  mime_type: "text/markdown", size_bytes: DEFAULT_CLAUDE_MD.length,  is_directory: false, updated_at: now }, uo
    ),
    sb.from("workspace_files").upsert(
      { user_id: uid, path: `${safeName}/MEMORY.md`,  name: "MEMORY.md",  content: DEFAULT_MEMORY_MD,  mime_type: "text/markdown", size_bytes: DEFAULT_MEMORY_MD.length,  is_directory: false, updated_at: now }, uo
    ),
    sb.from("workspace_files").upsert(
      { user_id: uid, path: `${safeName}/00_Resources`, name: "00_Resources", content: null, mime_type: null, size_bytes: 0, is_directory: true, updated_at: now }, uo
    ),
  ]);

  const err = results.find(r => r.error)?.error;
  if (err) return res.status(500).json({ error: err.message });
  res.json({ status: "ok", path: safeName });
});

// ── Workspace context summary (used by chat route) ───────────────────────────

router.get("/context", requireAuth, async (req, res) => {
  const sb = _getClient(req.token);
  if (!sb) {
    return res.json({
      mermaidDiagram: DEFAULT_MERMAID,
      agentOverrides: {},
      contextInjection: DEFAULT_CONTEXT_INJECTION,
      claudeMd: "",
      memoryMd: "",
      resources: [],
    });
  }

  try {
    const [agentCfg, ctxInj, files] = await Promise.all([
      sb.from("user_agent_configs").select("mermaid_diagram, agent_overrides").eq("user_id", req.user.id).single(),
      sb.from("user_context_injection").select("rules").eq("user_id", req.user.id).single(),
      sb.from("workspace_files").select("path, name, content, mime_type, is_directory").eq("user_id", req.user.id).order("path"),
    ]);

    const allFiles = files.data ?? [];
    const claudeMd  = allFiles.find(f => f.path === "CLAUDE.md")?.content ?? "";
    const memoryMd  = allFiles.find(f => f.path === "MEMORY.md")?.content ?? "";
    const resources = allFiles.filter(f => !f.is_directory && f.path !== "CLAUDE.md" && f.path !== "MEMORY.md");

    res.json({
      mermaidDiagram:   agentCfg.data?.mermaid_diagram ?? DEFAULT_MERMAID,
      agentOverrides:   agentCfg.data?.agent_overrides ?? {},
      contextInjection: ctxInj.data?.rules             ?? DEFAULT_CONTEXT_INJECTION,
      claudeMd,
      memoryMd,
      resources: resources.map(f => ({ path: f.path, name: f.name, mime_type: f.mime_type })),
      files: allFiles
        .filter(f => !f.path.startsWith("_context/"))
        .map(f => ({ path: f.path, name: f.name, is_directory: f.is_directory, mime_type: f.mime_type })),
    });
  } catch (err) {
    console.error("[workspace/context]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Server-side defaults (read-only, never written by users) ─────────────────

router.get("/defaults/:ruleId/:item", requireAuth, async (req, res) => {
  const { ruleId, item } = req.params;
  // Strict validation — no path traversal possible
  if (!/^[a-z_-]+$/.test(ruleId) || !/^[a-zA-Z0-9_.:-]+$/.test(item)) {
    return res.status(400).json({ error: "Invalid path" });
  }
  // Try .md, .js, then bare name in order
  for (const name of [`${item}.md`, `${item}.js`, item]) {
    try {
      const content = await readFile(join(PROJECT_ROOT, ruleId, name), "utf8");
      return res.json({ content });
    } catch {}
  }
  res.json({ content: "" });
});

export default router;
