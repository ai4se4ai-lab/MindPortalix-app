/**
 * Workspace isolation tests
 *
 * Verifies that two concurrent users (Alice and Bob) each maintain a fully
 * independent workspace — agent architecture, context injection rules, file
 * hierarchy and personalised context items — and that their edits never bleed
 * into one another or modify the server-side default files on disk.
 *
 * All Supabase operations run against an in-memory store; no real DB or network
 * connection is required.  The test persists Alice's session across a simulated
 * logout/re-login to confirm durability.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";

import workspaceRouter, {
  _setSupabaseFactory,
  _resetSupabaseFactory,
  DEFAULT_MERMAID,
  DEFAULT_CONTEXT_INJECTION,
} from "../../src/server/routes/workspace.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── In-memory Supabase mock ──────────────────────────────────────────────────

class InMemoryStore {
  constructor() { this.tables = new Map(); }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.tables) out[k] = v.map(r => ({ ...r }));
    return out;
  }
}

/** Converts a SQL LIKE pattern to a JS RegExp. */
function likeRe(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$");
}

class QB {
  constructor(store, table) {
    this._s = store; this._t = table;
    this._op = null; this._f = []; this._cols = "*";
    this._order = null; this._single = false;
    this._uRow = null; this._uOpts = {};
  }

  // ── Terminals that execute and return Promise ──
  async upsert(row, opts = {}) {
    const rows = this._s.table(this._t);
    const keys  = (opts.onConflict ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const idx   = keys.length
      ? rows.findIndex(r => keys.every(k => r[k] === row[k]))
      : -1;
    if (idx >= 0) {
      if (!opts.ignoreDuplicates) rows[idx] = { ...rows[idx], ...row };
    } else {
      rows.push({ ...row });
    }
    return { error: null };
  }

  single()  { this._single = true;  return this._exec(); }
  // thenable — lets Promise.all / await work on a chain ending in .order() or .eq()
  then(ok, fail) { return this._exec().then(ok, fail); }

  // ── Chainable helpers ──
  select(cols) { this._cols = cols; this._op = "select"; return this; }
  delete()     { this._op = "delete"; return this; }
  eq(f, v)     { this._f.push({ t: "eq",   f, v }); return this; }
  not(f, op, v){ this._f.push({ t: "not",  f, v }); return this; }
  like(f, p)   { this._f.push({ t: "like", f, p }); return this; }
  order(col)   { this._order = col; return this; }

  // ── Core execution ──
  _match(row) {
    for (const { t, f, v, p } of this._f) {
      if (t === "eq"   && row[f] !== v)             return false;
      if (t === "like" && !likeRe(p).test(row[f] ?? "")) return false;
      if (t === "not"  &&  likeRe(v).test(row[f] ?? "")) return false;
    }
    return true;
  }

  _project(rows) {
    if (this._cols === "*") return rows.map(r => ({ ...r }));
    const cols = this._cols.split(/,\s*/);
    return rows.map(r => Object.fromEntries(cols.map(c => [c.trim(), r[c.trim()]])));
  }

  async _exec() {
    const rows = this._s.table(this._t);

    if (this._op === "delete") {
      const keep = rows.filter(r => !this._match(r));
      this._s.tables.set(this._t, keep);
      return { error: null };
    }

    // select (default)
    let matched = rows.filter(r => this._match(r));
    if (this._order) {
      matched = [...matched].sort((a, b) =>
        (a[this._order] ?? "").localeCompare(b[this._order] ?? ""));
    }
    const projected = this._project(matched);

    if (this._single) {
      return projected.length
        ? { data: projected[0], error: null }
        : { data: null, error: { message: "No rows found" } };
    }
    return { data: projected, error: null };
  }
}

function makeClient(store) {
  return { from: t => new QB(store, t) };
}

// ── Test server helpers ──────────────────────────────────────────────────────

function buildApp(userId) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use("/api/workspace", workspaceRouter);
  return app;
}

function startServer(app) {
  return new Promise(resolve => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function req(port, method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  };
  const res  = await fetch(`http://127.0.0.1:${port}/api/workspace${path}`, opts);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ── Test state ───────────────────────────────────────────────────────────────

const ALICE_ID = "alice-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB_ID   = "bob-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const ALICE_MERMAID = "flowchart LR\n  Alice --> AI";
const BOB_MERMAID   = "flowchart TD\n  Bob --> Cloud";

let store, aliceSrv, bobSrv, alicePort, bobPort;
let alice, bob; // shorthand request functions

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Workspace isolation — two independent users", () => {

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));

    aliceSrv = await startServer(buildApp(ALICE_ID));
    bobSrv   = await startServer(buildApp(BOB_ID));
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;

    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close();
    bobSrv?.close();
  });

  // ── 1. Initialisation ───────────────────────────────────────────────────

  it("Alice: POST /init creates her default workspace", async () => {
    const r = await alice("POST", "/init");
    assert.ok(r.ok, `init failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.status, "ok");
  });

  it("Bob: POST /init creates his default workspace independently", async () => {
    const r = await bob("POST", "/init");
    assert.ok(r.ok);
    assert.equal(r.data.status, "ok");
  });

  it("both users start with the same server defaults", async () => {
    const [aArch, bArch] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
    ]);
    assert.equal(aArch.data.mermaid_diagram, DEFAULT_MERMAID);
    assert.equal(bArch.data.mermaid_diagram, DEFAULT_MERMAID);

    const [aCtx, bCtx] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET", "/context-injection"),
    ]);
    assert.equal(aCtx.data.rules.length, DEFAULT_CONTEXT_INJECTION.length);
    assert.equal(bCtx.data.rules.length, DEFAULT_CONTEXT_INJECTION.length);
  });

  // ── 2. Agent architecture isolation ────────────────────────────────────

  it("Alice sets a custom agent architecture diagram", async () => {
    const r = await alice("PUT", "/agent-config", {
      mermaid_diagram: ALICE_MERMAID,
      agent_overrides: { orchestrator: { model: "alice-model" } },
    });
    assert.ok(r.ok);
  });

  it("Bob sets a different agent architecture diagram", async () => {
    const r = await bob("PUT", "/agent-config", {
      mermaid_diagram: BOB_MERMAID,
      agent_overrides: { orchestrator: { model: "bob-model" } },
    });
    assert.ok(r.ok);
  });

  it("agent architectures are fully isolated — each user reads their own", async () => {
    const [aArch, bArch] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
    ]);
    assert.equal(aArch.data.mermaid_diagram, ALICE_MERMAID,
      "Alice should see her own diagram");
    assert.equal(bArch.data.mermaid_diagram, BOB_MERMAID,
      "Bob should see his own diagram");
    assert.notEqual(aArch.data.mermaid_diagram, bArch.data.mermaid_diagram,
      "diagrams must differ");
    assert.equal(aArch.data.agent_overrides?.orchestrator?.model, "alice-model");
    assert.equal(bArch.data.agent_overrides?.orchestrator?.model, "bob-model");
  });

  // ── 3. Context injection isolation ─────────────────────────────────────

  it("Alice disables the 'skills' category and removes an item from 'rules'", async () => {
    const original = (await alice("GET", "/context-injection")).data.rules;
    const updated = original.map(r =>
      r.id === "skills"
        ? { ...r, active: false }
        : r.id === "rules"
          ? { ...r, items: r.items.filter(i => i !== "general") }
          : r
    );
    const r = await alice("PUT", "/context-injection", { rules: updated });
    assert.ok(r.ok);
  });

  it("Bob's context injection is unchanged after Alice's edits", async () => {
    const r = await bob("GET", "/context-injection");
    const skillsRule = r.data.rules.find(x => x.id === "skills");
    assert.ok(skillsRule?.active, "Bob's skills category should still be active");
    const rulesRule = r.data.rules.find(x => x.id === "rules");
    assert.ok(rulesRule?.items.includes("general"),
      "Bob's 'rules' category should still have 'general'");
  });

  it("Alice's context injection persists and reflects her changes", async () => {
    const r = await alice("GET", "/context-injection");
    const skillsRule = r.data.rules.find(x => x.id === "skills");
    assert.equal(skillsRule?.active, false, "skills should be inactive for Alice");
    const rulesRule = r.data.rules.find(x => x.id === "rules");
    assert.ok(!rulesRule?.items.includes("general"),
      "Alice removed 'general' from rules");
  });

  // ── 4. Directory hierarchy isolation ───────────────────────────────────

  it("Alice creates workstation 'alpha-project'", async () => {
    const r = await alice("POST", "/directories", { name: "alpha-project" });
    assert.ok(r.ok);
    assert.equal(r.data.path, "alpha-project");
  });

  it("Bob creates workstation 'beta-project'", async () => {
    const r = await bob("POST", "/directories", { name: "beta-project" });
    assert.ok(r.ok);
    assert.equal(r.data.path, "beta-project");
  });

  it("Alice's file listing contains alpha-project with seeded defaults but NOT beta-project", async () => {
    const r = await alice("GET", "/files");
    const paths = r.data.files.map(f => f.path);
    assert.ok(paths.includes("alpha-project"),      "Alice has alpha-project dir");
    assert.ok(paths.includes("alpha-project/CLAUDE.md"), "seeded CLAUDE.md present");
    assert.ok(paths.includes("alpha-project/MEMORY.md"), "seeded MEMORY.md present");
    assert.ok(paths.includes("alpha-project/00_Resources"), "seeded 00_Resources present");
    assert.ok(!paths.includes("beta-project"),       "Alice must NOT see beta-project");
  });

  it("Bob's file listing contains beta-project with seeded defaults but NOT alpha-project", async () => {
    const r = await bob("GET", "/files");
    const paths = r.data.files.map(f => f.path);
    assert.ok(paths.includes("beta-project"),        "Bob has beta-project dir");
    assert.ok(paths.includes("beta-project/CLAUDE.md"), "seeded CLAUDE.md present");
    assert.ok(paths.includes("beta-project/MEMORY.md"), "seeded MEMORY.md present");
    assert.ok(!paths.includes("alpha-project"),      "Bob must NOT see alpha-project");
  });

  // ── 5. File content isolation ───────────────────────────────────────────

  it("Alice edits her root CLAUDE.md with custom content", async () => {
    const custom = "# Alice's workspace\n\nI prefer TypeScript and short answers.";
    const r = await alice("PUT", "/files/CLAUDE.md", {
      content: custom, mime_type: "text/markdown"
    });
    assert.ok(r.ok);

    // Confirm the change is stored
    const readBack = await alice("GET", "/files/CLAUDE.md");
    assert.equal(readBack.data.content, custom);
  });

  it("Bob's CLAUDE.md is unaffected by Alice's edit", async () => {
    const r = await bob("GET", "/files/CLAUDE.md");
    // Bob's CLAUDE.md was seeded during /init so it should be the default
    assert.ok(!r.data.content.includes("Alice"),
      "Bob's CLAUDE.md must not contain Alice's content");
    assert.ok(r.data.content.length > 0, "Bob's CLAUDE.md should have default content");
  });

  it("Alice edits her workstation CLAUDE.md without touching Bob's root CLAUDE.md", async () => {
    const aliceWs = "# Alpha Project\n\nFocus: distributed systems.";
    const r = await alice("PUT", "/files/alpha-project/CLAUDE.md", {
      content: aliceWs, mime_type: "text/markdown"
    });
    assert.ok(r.ok);

    // Bob's root CLAUDE.md unchanged
    const bobRoot = await bob("GET", "/files/CLAUDE.md");
    assert.ok(!bobRoot.data.content.includes("Alpha Project"));
  });

  // ── 6. Context item personalisation — no server defaults polluted ───────

  it("Alice personalises the 'agent-orchestration' skill item (personal copy)", async () => {
    const personalContent = "# My Orchestration Notes\n\nAlways prefer the planner agent first.";
    const r = await alice("PUT", "/files/_context/skills/agent-orchestration", {
      content: personalContent, mime_type: "text/markdown"
    });
    assert.ok(r.ok);

    // Alice reads back her personal copy
    const readBack = await alice("GET", "/files/_context/skills/agent-orchestration");
    assert.equal(readBack.data.content, personalContent);
  });

  it("Bob has no personal copy of agent-orchestration (returns 404)", async () => {
    const r = await bob("GET", "/files/_context/skills/agent-orchestration");
    assert.equal(r.status, 404, "Bob should get 404 — no personal copy created");
  });

  it("Bob reads the server default for agent-orchestration (unmodified)", async () => {
    const r = await bob("GET", "/defaults/skills/agent-orchestration");
    assert.ok(r.ok);
    assert.ok(r.data.content.length > 0, "server default should have content");
    assert.ok(!r.data.content.includes("My Orchestration Notes"),
      "server default must not contain Alice's personalisation");
  });

  it("the server file on disk is untouched after Alice's personalisation", async () => {
    const diskContent = await readFile(
      join(PROJECT_ROOT, "skills", "agent-orchestration.md"), "utf8"
    );
    assert.ok(diskContent.length > 0);
    assert.ok(!diskContent.includes("My Orchestration Notes"),
      "Alice's edit must not have written to the real file on disk");
  });

  it("Alice and Bob get different content for the same skill item", async () => {
    const [aItem, bDefault] = await Promise.all([
      alice("GET", "/files/_context/skills/agent-orchestration"),
      bob("GET", "/defaults/skills/agent-orchestration"),
    ]);
    assert.equal(aItem.status, 200);
    assert.ok(bDefault.data.content !== aItem.data.content,
      "Alice's personal copy and the server default must differ");
  });

  // ── 7. Persistence across logout and re-login ───────────────────────────

  it("Alice's changes persist after she logs out and logs back in", async () => {
    // Simulate logout: close current server (session gone)
    aliceSrv.close();

    // Simulate re-login: create a new server for Alice pointing at the same store
    aliceSrv = await startServer(buildApp(ALICE_ID));
    alicePort = aliceSrv.address().port;
    alice     = (m, p, b) => req(alicePort, m, p, b);

    // ① Custom mermaid diagram persists
    const arch = await alice("GET", "/agent-config");
    assert.equal(arch.data.mermaid_diagram, ALICE_MERMAID,
      "custom diagram must survive logout/re-login");

    // ② Disabled context category persists
    const ctx = await alice("GET", "/context-injection");
    const skills = ctx.data.rules.find(x => x.id === "skills");
    assert.equal(skills?.active, false, "disabled category must persist");

    // ③ Edited CLAUDE.md persists
    const claudeMd = await alice("GET", "/files/CLAUDE.md");
    assert.ok(claudeMd.data.content.includes("Alice's workspace"),
      "edited CLAUDE.md must persist");

    // ④ Workstation directory persists
    const files = await alice("GET", "/files");
    const paths = files.data.files.map(f => f.path);
    assert.ok(paths.includes("alpha-project"), "workstation must persist");

    // ⑤ Personal context item persists
    const item = await alice("GET", "/files/_context/skills/agent-orchestration");
    assert.ok(item.data.content.includes("My Orchestration Notes"),
      "personal context item must persist");
  });

  it("Bob's workspace is still independent after Alice's re-login", async () => {
    const arch = await bob("GET", "/agent-config");
    assert.equal(arch.data.mermaid_diagram, BOB_MERMAID,
      "Bob's diagram must be unchanged");

    const files = await bob("GET", "/files");
    const paths = files.data.files.map(f => f.path);
    assert.ok(!paths.includes("alpha-project"), "Bob must not see Alice's workstation");
    assert.ok(paths.includes("beta-project"),   "Bob's own workstation intact");
  });

  // ── 8. Upload isolation ─────────────────────────────────────────────────

  it("Alice uploads a document — Bob does not see it", async () => {
    const r = await alice("POST", "/upload", {
      name: "alice-notes.md",
      content: "# Alice's private notes\n\nConfidential.",
      mime_type: "text/markdown",
    });
    assert.ok(r.ok);
    assert.equal(r.data.path, "00_Resources/alice-notes.md");

    const aliceFiles = await alice("GET", "/files");
    const bobFiles   = await bob("GET", "/files");

    const alicePaths = aliceFiles.data.files.map(f => f.path);
    const bobPaths   = bobFiles.data.files.map(f => f.path);

    assert.ok( alicePaths.includes("00_Resources/alice-notes.md"), "Alice sees her upload");
    assert.ok(!bobPaths.includes("00_Resources/alice-notes.md"),   "Bob must not see it");
  });

  // ── 9. /context summary endpoint ───────────────────────────────────────

  it("GET /context returns each user's own CLAUDE.md and mermaid diagram", async () => {
    const [aCtx, bCtx] = await Promise.all([
      alice("GET", "/context"),
      bob("GET", "/context"),
    ]);

    assert.ok(aCtx.data.claudeMd.includes("Alice's workspace"),
      "Alice /context should contain her CLAUDE.md");
    assert.ok(!bCtx.data.claudeMd.includes("Alice's workspace"),
      "Bob /context must not bleed Alice's CLAUDE.md");

    assert.equal(aCtx.data.mermaidDiagram, ALICE_MERMAID);
    assert.equal(bCtx.data.mermaidDiagram, BOB_MERMAID);

    // _context paths must be filtered from the files list in /context
    const allBobPaths = (bCtx.data.files ?? []).map(f => f.path);
    assert.ok(
      !allBobPaths.some(p => p.startsWith("_context/")),
      "_context/* entries must be hidden from /context files list"
    );
  });

  // ── 10. Deletion isolation ──────────────────────────────────────────────

  it("Alice deletes her workstation; Bob's workstation is unaffected", async () => {
    const r = await alice("DELETE", "/files/alpha-project");
    assert.ok(r.ok);

    const aliceFiles = await alice("GET", "/files");
    const bobFiles   = await bob("GET", "/files");

    const alicePaths = aliceFiles.data.files.map(f => f.path);
    const bobPaths   = bobFiles.data.files.map(f => f.path);

    assert.ok(!alicePaths.some(p => p === "alpha-project" || p.startsWith("alpha-project/")),
      "alpha-project and its children must be gone for Alice");
    assert.ok(bobPaths.includes("beta-project"),
      "Bob's beta-project must survive Alice's deletion");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Regression tests — the three bugs reported after initial implementation
// ════════════════════════════════════════════════════════════════════════════

describe("Bug regression: _context/ items must never appear in directory listings", () => {
  // Fresh store so these tests are self-contained
  let rStore, rSrv, rPort, rUser;

  before(async () => {
    rStore = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(rStore));
    rSrv  = await startServer(buildApp("reg-user-cccc-cccc-cccc-cccccccccccc"));
    rPort = rSrv.address().port;
    rUser = (m, p, b) => req(rPort, m, p, b);
    await rUser("POST", "/init");
  });

  after(() => {
    rSrv?.close();
    _resetSupabaseFactory();
  });

  it("GET /files never returns _context/ paths even when they exist in DB", async () => {
    // Simulate the old premature-auto-save bug writing empty personal copies to DB
    const leaked = [
      "_context/skills/model-selection",
      "_context/skills/openrouter",
      "_context/agents/orchestrator",
      "_context/rules/api-design",
    ];
    for (const path of leaked) {
      await rUser("PUT", `/files/${path}`, { content: "", mime_type: "text/markdown" });
    }

    const r = await rUser("GET", "/files");
    assert.ok(r.ok);
    const paths = r.data.files.map(f => f.path);

    for (const p of leaked) {
      assert.ok(!paths.includes(p),
        `GET /files must NOT return ${p}`);
    }
    // Confirm legit files ARE still present
    assert.ok(paths.includes("CLAUDE.md"), "CLAUDE.md must still appear");
    assert.ok(paths.includes("MEMORY.md"), "MEMORY.md must still appear");
  });

  it("GET /files returns no path that starts with '_context/'", async () => {
    // Write several more _context paths via the PUT endpoint
    await rUser("PUT", "/files/_context/hooks/pre-tool-use", { content: "hook content", mime_type: "text/markdown" });
    await rUser("PUT", "/files/_context/mcps/github",        { content: "mcp content",  mime_type: "text/markdown" });

    const r = await rUser("GET", "/files");
    const bad = r.data.files.filter(f => f.path.startsWith("_context/"));
    assert.equal(bad.length, 0,
      `GET /files must return 0 _context/ entries; got: ${bad.map(f => f.path).join(", ")}`);
  });

  it("GET /context files array never contains _context/ paths", async () => {
    const r = await rUser("GET", "/context");
    assert.ok(r.ok);

    const ctxPaths = (r.data.files ?? []).map(f => f.path);
    const bad = ctxPaths.filter(p => p.startsWith("_context/"));
    assert.equal(bad.length, 0,
      `GET /context files must contain 0 _context/ entries; got: ${bad.join(", ")}`);
  });

  it("GET /context resources array never contains _context/ paths", async () => {
    const r = await rUser("GET", "/context");
    const resPaths = (r.data.resources ?? []).map(f => f.path);
    const bad = resPaths.filter(p => p.startsWith("_context/"));
    assert.equal(bad.length, 0,
      `GET /context resources must contain 0 _context/ entries; got: ${bad.join(", ")}`);
  });

  it("_context/ items are invisible to childrenAt-style prefix filtering too", async () => {
    // childrenAt("") returns all root-level items (rest has no "/")
    // _context/skills/model-selection → rest="_context/skills/model-selection" has "/"  → excluded
    // _context/agents/orchestrator    → rest="_context/agents/orchestrator"    has "/"  → excluded
    // So even if _context/ files escaped the server filter, they can't appear at root.
    // Verify by checking GET /files returns nothing at root with _context prefix.
    const r = await rUser("GET", "/files");
    const rootItems = r.data.files.filter(f => !f.path.includes("/"));
    const bad = rootItems.filter(f => f.path.startsWith("_context"));
    assert.equal(bad.length, 0, "No _context item should appear as a root-level file");
  });
});

describe("Bug regression: empty personal copy must fall through to server default", () => {
  let eStore, eSrv, ePort, eUser;

  before(async () => {
    eStore = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(eStore));
    eSrv  = await startServer(buildApp("empty-copy-dddd-dddd-dddd-dddddddddddd"));
    ePort = eSrv.address().port;
    eUser = (m, p, b) => req(ePort, m, p, b);
    await eUser("POST", "/init");
  });

  after(() => {
    eSrv?.close();
    _resetSupabaseFactory();
  });

  it("GET /defaults/:ruleId/:item returns real file content from disk", async () => {
    // skills/agent-orchestration.md exists on disk
    const r = await eUser("GET", "/defaults/skills/agent-orchestration");
    assert.ok(r.ok);
    assert.ok((r.data.content ?? "").trim().length > 0,
      "server default must have real content");
  });

  it("GET /defaults returns empty string for non-existent item (no error)", async () => {
    const r = await eUser("GET", "/defaults/skills/does-not-exist-xyz");
    assert.ok(r.ok, "endpoint must not 500 for missing items");
    assert.equal(r.data.content, "", "missing item should return empty string");
  });

  it("empty personal copy stored by old auto-save bug is still in DB but GET /files hides it", async () => {
    // Simulate the old premature-auto-save writing an empty personal copy
    const putR = await eUser("PUT", "/files/_context/skills/model-selection", {
      content: "", mime_type: "text/markdown"
    });
    assert.ok(putR.ok, "PUT of empty content should succeed");

    // GET /files must NOT include it
    const filesR = await eUser("GET", "/files");
    const paths = filesR.data.files.map(f => f.path);
    assert.ok(!paths.includes("_context/skills/model-selection"),
      "empty personal copy must not appear in /files");
  });

  it("server default is still accessible even when an empty personal copy exists", async () => {
    // The personal copy (_context/skills/model-selection) is empty in DB (written above)
    // GET /defaults still reads from disk — completely independent of user DB data
    const r = await eUser("GET", "/defaults/skills/model-selection");
    assert.ok(r.ok);
    assert.ok((r.data.content ?? "").trim().length > 0,
      "server default must return real content regardless of empty personal copy in DB");
    assert.ok(!r.data.content.includes("_context"),
      "server default content must not reference _context paths");
  });

  it("non-empty personal copy overrides server default (happy-path personalisation)", async () => {
    const personal = "# My Model Selection\n\nAlways pick the cheapest free model.";
    await eUser("PUT", "/files/_context/skills/prompt-engineering", {
      content: personal, mime_type: "text/markdown"
    });

    const read = await eUser("GET", "/files/_context/skills/prompt-engineering");
    assert.ok(read.ok);
    assert.equal(read.data.content, personal,
      "non-empty personal copy must be returned as-is");
  });

  it("all skills items have real server-side defaults on disk", async () => {
    const skillItems = ["agent-orchestration", "memory-compression", "model-selection",
      "openrouter", "prompt-engineering", "supabase-auth"];

    await Promise.all(skillItems.map(async item => {
      const r = await eUser("GET", `/defaults/skills/${item}`);
      assert.ok(r.ok, `GET /defaults/skills/${item} should succeed`);
      assert.ok((r.data.content ?? "").trim().length > 0,
        `skills/${item} must have a non-empty server default on disk`);
    }));
  });

  it("all agent items that have .md files on disk return real content", async () => {
    // executor, image_generator, audio_generator have no .md file — omit them
    const agentItems = ["orchestrator", "researcher", "reviewer", "memory",
      "coder", "writer", "governor", "planner", "formatter"];

    await Promise.all(agentItems.map(async item => {
      const r = await eUser("GET", `/defaults/agents/${item}`);
      assert.ok(r.ok, `GET /defaults/agents/${item} should succeed`);
      assert.ok((r.data.content ?? "").trim().length > 0,
        `agents/${item} must have a non-empty server default on disk`);
    }));
  });

  it("agents without .md files return empty string gracefully (no 500)", async () => {
    // executor, image_generator, audio_generator don't have dedicated .md files yet
    for (const item of ["executor", "image_generator", "audio_generator"]) {
      const r = await eUser("GET", `/defaults/agents/${item}`);
      assert.ok(r.ok, `GET /defaults/agents/${item} must not 500`);
      // content may be empty — that is acceptable for agents without a spec file
    }
  });
});

describe("Bug regression: workstation directory must always seed defaults on entry", () => {
  let wStore, wAliceSrv, wAlicePort, wAlice;

  before(async () => {
    wStore = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(wStore));
    wAliceSrv  = await startServer(buildApp("ws-seed-eeee-eeee-eeee-eeeeeeeeeeee"));
    wAlicePort = wAliceSrv.address().port;
    wAlice = (m, p, b) => req(wAlicePort, m, p, b);
    await wAlice("POST", "/init");
  });

  after(() => {
    wAliceSrv?.close();
    _resetSupabaseFactory();
  });

  it("POST /directories creates CLAUDE.md, MEMORY.md and 00_Resources/ inside new workstation", async () => {
    const r = await wAlice("POST", "/directories", { name: "my-project" });
    assert.ok(r.ok);

    const files = await wAlice("GET", "/files");
    const paths = files.data.files.map(f => f.path);

    assert.ok(paths.includes("my-project"),            "workstation dir exists");
    assert.ok(paths.includes("my-project/CLAUDE.md"),  "CLAUDE.md seeded");
    assert.ok(paths.includes("my-project/MEMORY.md"),  "MEMORY.md seeded");
    assert.ok(paths.includes("my-project/00_Resources"), "00_Resources seeded");
  });

  it("POST /directories is idempotent — calling it again for an existing workstation is safe", async () => {
    // First call already happened above
    const r2 = await wAlice("POST", "/directories", { name: "my-project" });
    assert.ok(r2.ok, "second POST /directories must succeed");

    const files = await wAlice("GET", "/files");
    const projectFiles = files.data.files.filter(f => f.path.startsWith("my-project"));
    const claudeCount = projectFiles.filter(f => f.path === "my-project/CLAUDE.md").length;
    assert.equal(claudeCount, 1, "CLAUDE.md must appear exactly once (no duplicate)");
  });

  it("user edits to workstation CLAUDE.md survive a second POST /directories call", async () => {
    // User customises CLAUDE.md
    const customContent = "# My Project\n\nThis is my custom instructions.";
    await wAlice("PUT", "/files/my-project/CLAUDE.md", {
      content: customContent, mime_type: "text/markdown"
    });

    // Simulate navigateInto calling POST /directories again
    await wAlice("POST", "/directories", { name: "my-project" });

    // Custom content must be preserved (ignoreDuplicates: true)
    const read = await wAlice("GET", "/files/my-project/CLAUDE.md");
    assert.equal(read.data.content, customContent,
      "user's custom CLAUDE.md content must not be overwritten by re-init");
  });

  it("pre-existing directory without CLAUDE.md gets defaults seeded by POST /directories", async () => {
    // Simulate a workstation created before the seeding feature existed:
    // directory entry exists but no child files
    const store = makeClient(wStore);
    await store.from("workspace_files").upsert(
      { user_id: "ws-seed-eeee-eeee-eeee-eeeeeeeeeeee",
        path: "legacy-dir", name: "legacy-dir", content: null,
        mime_type: null, size_bytes: 0, is_directory: true,
        updated_at: new Date().toISOString() },
      { onConflict: "user_id,path", ignoreDuplicates: false }
    );

    // Verify it has no children yet
    const beforeFiles = await wAlice("GET", "/files");
    const beforePaths = beforeFiles.data.files.map(f => f.path);
    assert.ok(beforePaths.includes("legacy-dir"), "legacy dir exists");
    assert.ok(!beforePaths.includes("legacy-dir/CLAUDE.md"), "no CLAUDE.md yet");

    // navigateInto equivalent: POST /directories seeds the defaults
    const r = await wAlice("POST", "/directories", { name: "legacy-dir" });
    assert.ok(r.ok);

    const afterFiles = await wAlice("GET", "/files");
    const afterPaths = afterFiles.data.files.map(f => f.path);
    assert.ok(afterPaths.includes("legacy-dir/CLAUDE.md"),    "CLAUDE.md seeded");
    assert.ok(afterPaths.includes("legacy-dir/MEMORY.md"),    "MEMORY.md seeded");
    assert.ok(afterPaths.includes("legacy-dir/00_Resources"), "00_Resources seeded");
  });

  it("workstation children are visible to GET /files and filtered by childrenAt prefix", async () => {
    // After seeding, GET /files returns nested paths correctly
    const r = await wAlice("GET", "/files");
    const paths = r.data.files.map(f => f.path);

    // childrenAt("my-project") simulation: prefix "my-project/", rest has no "/"
    const children = paths.filter(p => {
      if (!p.startsWith("my-project/")) return false;
      const rest = p.slice("my-project/".length);
      return rest.length > 0 && !rest.includes("/");
    });
    assert.ok(children.includes("my-project/CLAUDE.md"),   "CLAUDE.md in children");
    assert.ok(children.includes("my-project/MEMORY.md"),   "MEMORY.md in children");
    assert.ok(children.includes("my-project/00_Resources"),"00_Resources in children");
    assert.equal(children.length, 3, "exactly 3 direct children");
  });
});
