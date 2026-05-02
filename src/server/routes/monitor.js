import { Router } from "express";
import { subscribe } from "../../monitor/broadcaster.js";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { listAgents } from "../../agents/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const router = Router();

// ── SSE live monitor stream ──────────────────────────────────────────
router.get("/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
  }, 20_000);

  const unsub = subscribe(({ event, data }) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
});

// ── Agent registry snapshot ──────────────────────────────────────────
router.get("/agents", (_req, res) => {
  res.json({ agents: listAgents() });
});

// ── Directory tree ────────────────────────────────────────────────────
const INTERESTING_FILES = new Set(["CLAUDE.md", "MEMORY.md"]);
const INTERESTING_DIRS  = new Set(["00_Resources", "skills", "rules", "agents", "hooks"]);
const IGNORE_DIRS       = new Set(["node_modules", ".git", ".claude", "supabase", ".next", "dist", "build", "coverage"]);

async function buildTree(dirPath, depth = 0, maxDepth = 4) {
  const name = dirPath.split(/[\\/]/).pop() || "/";
  const node = {
    name,
    path: relative(ROOT, dirPath).replace(/\\/g, "/") || ".",
    type: "dir",
    children: [],
  };

  if (depth > maxDepth) return node;

  let entries;
  try { entries = await readdir(dirPath, { withFileTypes: true }); }
  catch { return node; }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const child = await buildTree(join(dirPath, entry.name), depth + 1, maxDepth);
      node.children.push(child);
    } else if (entry.isFile()) {
      const inInterestingDir = INTERESTING_DIRS.has(name);
      if (INTERESTING_FILES.has(entry.name) || inInterestingDir) {
        node.children.push({
          name: entry.name,
          path: relative(ROOT, join(dirPath, entry.name)).replace(/\\/g, "/"),
          type: "file",
        });
      }
    }
  }
  return node;
}

router.get("/directory", async (_req, res) => {
  try {
    const tree = await buildTree(ROOT);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
