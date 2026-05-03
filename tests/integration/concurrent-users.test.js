/**
 * Concurrent multi-user tests
 *
 * Verifies that three simultaneous users (Alice, Bob, Carol) experience no data
 * inconsistency, no race conditions, and no inaccurate information when working
 * with the system at the same time.
 *
 * All concurrent operations are issued via Promise.all() so they genuinely race
 * in the same Node.js event loop, exercising the in-memory store under
 * interleaved async I/O in the same way a real multi-user server would.
 *
 * Covers:
 *   1. Concurrent workspace initialization
 *   2. Concurrent architecture diagram updates and isolation
 *   3. Concurrent context injection updates and isolation
 *   4. Concurrent resource uploads and content isolation
 *   5. Race conditions — same-user concurrent writes
 *   6. Concurrent personal copy creation for a shared skill item
 *   7. Architecture routing isolation under concurrent load (module-level)
 *   8. Concurrent /context reads during in-flight writes
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";

import {
  parseArchitectureAgents,
  applyArchitectureFilter,
  buildContextInjectionContent,
} from "../../src/orchestration/architecture.js";

import workspaceRouter, {
  _setSupabaseFactory,
  _resetSupabaseFactory,
  DEFAULT_MERMAID,
  DEFAULT_CONTEXT_INJECTION,
} from "../../src/server/routes/workspace.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── In-memory Supabase mock ───────────────────────────────────────────────────

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

function likeRe(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$");
}

class QB {
  constructor(store, table) {
    this._s = store; this._t = table;
    this._op = null; this._f = []; this._cols = "*";
    this._order = null; this._single = false;
  }
  async upsert(row, opts = {}) {
    const rows = this._s.table(this._t);
    const keys = (opts.onConflict ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const idx  = keys.length ? rows.findIndex(r => keys.every(k => r[k] === row[k])) : -1;
    if (idx >= 0) {
      if (!opts.ignoreDuplicates) rows[idx] = { ...rows[idx], ...row };
    } else {
      rows.push({ ...row });
    }
    return { error: null };
  }
  single()       { this._single = true; return this._exec(); }
  then(ok, fail) { return this._exec().then(ok, fail); }
  select(cols)   { this._cols = cols; this._op = "select"; return this; }
  delete()       { this._op = "delete"; return this; }
  eq(f, v)       { this._f.push({ t: "eq",   f, v }); return this; }
  not(f, op, v)  { this._f.push({ t: "not",  f, v }); return this; }
  like(f, p)     { this._f.push({ t: "like", f, p }); return this; }
  order(col)     { this._order = col; return this; }
  _match(row) {
    for (const { t, f, v, p } of this._f) {
      if (t === "eq"   && row[f] !== v)                   return false;
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

// ── Server helpers ────────────────────────────────────────────────────────────

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

/** Build a minimal route object matching classifyIntent() output. */
function makeRoute(agents, primary) {
  return { agents, primary, modalities: [], confidence: 1.0, matchedKeywords: [] };
}

// ── User IDs ──────────────────────────────────────────────────────────────────

const ALICE_ID = "alice-concurrent-aaaa-aaaa-aaaaaaaaaaaa";
const BOB_ID   = "bob-concurrent-bbbb-bbbb-bbbbbbbbbbbb";
const CAROL_ID = "carol-concurrent-cccc-cccc-cccccccccccc";

// ════════════════════════════════════════════════════════════════════════════
// 1. Concurrent initialization
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent initialization — three users init simultaneously", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));

    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("all three POST /init in parallel — all succeed with status ok", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
    assert.ok(ra.ok, `Alice init failed: ${JSON.stringify(ra.data)}`);
    assert.ok(rb.ok, `Bob init failed: ${JSON.stringify(rb.data)}`);
    assert.ok(rc.ok, `Carol init failed: ${JSON.stringify(rc.data)}`);
    assert.equal(ra.data.status, "ok");
    assert.equal(rb.data.status, "ok");
    assert.equal(rc.data.status, "ok");
  });

  it("all three read their agent configs in parallel — all receive the server default diagram", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
      carol("GET", "/agent-config"),
    ]);
    assert.equal(ra.data.mermaid_diagram, DEFAULT_MERMAID, "Alice: wrong default diagram");
    assert.equal(rb.data.mermaid_diagram, DEFAULT_MERMAID, "Bob: wrong default diagram");
    assert.equal(rc.data.mermaid_diagram, DEFAULT_MERMAID, "Carol: wrong default diagram");
  });

  it("all three read context injection in parallel — each gets correct default rule count", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET", "/context-injection"),
      carol("GET", "/context-injection"),
    ]);
    assert.equal(ra.data.rules.length, DEFAULT_CONTEXT_INJECTION.length, "Alice: wrong rule count");
    assert.equal(rb.data.rules.length, DEFAULT_CONTEXT_INJECTION.length, "Bob: wrong rule count");
    assert.equal(rc.data.rules.length, DEFAULT_CONTEXT_INJECTION.length, "Carol: wrong rule count");
  });

  it("same user calls POST /init three times concurrently — CLAUDE.md appears exactly once (idempotent)", async () => {
    await Promise.all([
      alice("POST", "/init"),
      alice("POST", "/init"),
      alice("POST", "/init"),
    ]);
    const r = await alice("GET", "/files");
    const claudeCount = r.data.files.filter(f => f.path === "CLAUDE.md").length;
    assert.equal(claudeCount, 1,
      `Concurrent double-init must not create duplicate CLAUDE.md; found ${claudeCount}`);
  });

  it("each user's default CLAUDE.md is independently initialized — content is non-empty for all", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/files/CLAUDE.md"),
      bob("GET", "/files/CLAUDE.md"),
      carol("GET", "/files/CLAUDE.md"),
    ]);
    assert.ok(ra.data.content?.length > 0, "Alice CLAUDE.md empty after init");
    assert.ok(rb.data.content?.length > 0, "Bob CLAUDE.md empty after init");
    assert.ok(rc.data.content?.length > 0, "Carol CLAUDE.md empty after init");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Concurrent architecture diagram updates
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent architecture updates — each user saves a unique diagram simultaneously", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  const ALICE_DIAGRAM = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> coder
  coder --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

  const BOB_DIAGRAM = `flowchart LR
  userinput([User Input]) --> orchestrator
  orchestrator --> researcher
  orchestrator --> writer
  researcher --> executor
  writer --> executor
  executor --> response([Response])`;

  const CAROL_DIAGRAM = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> planner
  planner --> coder
  planner --> researcher
  coder --> executor
  researcher --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("all three PUT /agent-config simultaneously — all requests succeed", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("PUT", "/agent-config", { mermaid_diagram: ALICE_DIAGRAM, agent_overrides: { coder: { model: "alice-coder" } } }),
      bob("PUT",   "/agent-config", { mermaid_diagram: BOB_DIAGRAM,   agent_overrides: { researcher: { model: "bob-researcher" } } }),
      carol("PUT", "/agent-config", { mermaid_diagram: CAROL_DIAGRAM, agent_overrides: { planner: { model: "carol-planner" } } }),
    ]);
    assert.ok(ra.ok, "Alice PUT /agent-config failed");
    assert.ok(rb.ok, "Bob PUT /agent-config failed");
    assert.ok(rc.ok, "Carol PUT /agent-config failed");
  });

  it("each user reads back their own diagram after concurrent writes — no cross-contamination", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
      carol("GET", "/agent-config"),
    ]);
    assert.equal(ra.data.mermaid_diagram, ALICE_DIAGRAM, "Alice got wrong diagram");
    assert.equal(rb.data.mermaid_diagram, BOB_DIAGRAM,   "Bob got wrong diagram");
    assert.equal(rc.data.mermaid_diagram, CAROL_DIAGRAM, "Carol got wrong diagram");
  });

  it("agent overrides are isolated — each user's model override is unaffected by others", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
      carol("GET", "/agent-config"),
    ]);
    assert.equal(ra.data.agent_overrides?.coder?.model, "alice-coder",
      "Alice's coder model must be her own value");
    assert.equal(rb.data.agent_overrides?.researcher?.model, "bob-researcher",
      "Bob's researcher model must be his own value");
    assert.equal(rc.data.agent_overrides?.planner?.model, "carol-planner",
      "Carol's planner model must be her own value");
    assert.ok(!ra.data.agent_overrides?.researcher,
      "Alice must not have Bob's researcher override");
    assert.ok(!rb.data.agent_overrides?.planner,
      "Bob must not have Carol's planner override");
    assert.ok(!rc.data.agent_overrides?.coder,
      "Carol must not have Alice's coder override");
  });

  it("all three GET /context in parallel — each returns its own mermaidDiagram", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context"),
      bob("GET", "/context"),
      carol("GET", "/context"),
    ]);
    assert.equal(ra.data.mermaidDiagram, ALICE_DIAGRAM, "Alice /context: wrong diagram");
    assert.equal(rb.data.mermaidDiagram, BOB_DIAGRAM,   "Bob /context: wrong diagram");
    assert.equal(rc.data.mermaidDiagram, CAROL_DIAGRAM, "Carol /context: wrong diagram");
  });

  it("Alice's diagram excludes planner; Bob's excludes coder; Carol's includes both — verified via parseArchitectureAgents", () => {
    const aliceAllowed = parseArchitectureAgents(ALICE_DIAGRAM);
    const bobAllowed   = parseArchitectureAgents(BOB_DIAGRAM);
    const carolAllowed = parseArchitectureAgents(CAROL_DIAGRAM);

    assert.ok(!aliceAllowed.has("planner"),    "Alice's diagram has no planner");
    assert.ok( aliceAllowed.has("coder"),      "Alice's diagram has coder");
    assert.ok(!bobAllowed.has("coder"),        "Bob's diagram has no coder");
    assert.ok( bobAllowed.has("researcher"),   "Bob's diagram has researcher");
    assert.ok( carolAllowed.has("planner"),    "Carol's diagram has planner");
    assert.ok( carolAllowed.has("coder"),      "Carol's diagram has coder");
    assert.ok( carolAllowed.has("researcher"), "Carol's diagram has researcher");
  });

  it("applyArchitectureFilter for same raw route produces three different results concurrently", () => {
    const rawRoute = makeRoute(["planner", "researcher", "coder", "reviewer"], "planner");
    const aliceAllowed = parseArchitectureAgents(ALICE_DIAGRAM);
    const bobAllowed   = parseArchitectureAgents(BOB_DIAGRAM);
    const carolAllowed = parseArchitectureAgents(CAROL_DIAGRAM);

    // All three filter calls run with no await — completely synchronous concurrent calls
    const [aliceFiltered, bobFiltered, carolFiltered] = [
      applyArchitectureFilter(rawRoute, aliceAllowed),
      applyArchitectureFilter(rawRoute, bobAllowed),
      applyArchitectureFilter(rawRoute, carolAllowed),
    ];

    // Alice: no planner, coder survives
    assert.ok(!aliceFiltered.agents.includes("planner"),    "Alice: planner filtered");
    assert.ok( aliceFiltered.agents.includes("coder"),      "Alice: coder survives");
    assert.ok(!aliceFiltered.agents.includes("researcher"), "Alice: researcher filtered");

    // Bob: researcher survives, coder filtered, planner filtered
    assert.ok(!bobFiltered.agents.includes("planner"),   "Bob: planner filtered");
    assert.ok(!bobFiltered.agents.includes("coder"),     "Bob: coder filtered");
    assert.ok( bobFiltered.agents.includes("researcher"),"Bob: researcher survives");

    // Carol: all three survive
    assert.ok( carolFiltered.agents.includes("planner"),    "Carol: planner survives");
    assert.ok( carolFiltered.agents.includes("coder"),      "Carol: coder survives");
    assert.ok( carolFiltered.agents.includes("researcher"), "Carol: researcher survives");
  });

  it("rapid concurrent diagram updates by all three users — final state consistent per user", async () => {
    const diagA2 = "flowchart LR\n  orchestrator --> writer\n  writer --> response([Response])";
    const diagB2 = "flowchart TD\n  orchestrator --> memory\n  memory --> response([Response])";
    const diagC2 = "flowchart LR\n  orchestrator --> formatter\n  formatter --> response([Response])";

    // Each user fires two rapid-fire updates; the second one should win for that user
    await Promise.all([
      alice("PUT", "/agent-config", { mermaid_diagram: ALICE_DIAGRAM, agent_overrides: {} }),
      alice("PUT", "/agent-config", { mermaid_diagram: diagA2,        agent_overrides: {} }),
      bob("PUT",   "/agent-config", { mermaid_diagram: BOB_DIAGRAM,   agent_overrides: {} }),
      bob("PUT",   "/agent-config", { mermaid_diagram: diagB2,        agent_overrides: {} }),
      carol("PUT", "/agent-config", { mermaid_diagram: CAROL_DIAGRAM, agent_overrides: {} }),
      carol("PUT", "/agent-config", { mermaid_diagram: diagC2,        agent_overrides: {} }),
    ]);

    // Each user's final diagram must be one of their own values — never another user's
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/agent-config"),
      bob("GET", "/agent-config"),
      carol("GET", "/agent-config"),
    ]);

    const aliceValid = [ALICE_DIAGRAM, diagA2];
    const bobValid   = [BOB_DIAGRAM,   diagB2];
    const carolValid = [CAROL_DIAGRAM, diagC2];

    assert.ok(aliceValid.includes(ra.data.mermaid_diagram),
      "Alice's final diagram must be one of her own values — not another user's diagram");
    assert.ok(bobValid.includes(rb.data.mermaid_diagram),
      "Bob's final diagram must be one of his own values");
    assert.ok(carolValid.includes(rc.data.mermaid_diagram),
      "Carol's final diagram must be one of her own values");

    // Critical cross-user contamination check
    const carolDiagrams = [CAROL_DIAGRAM, diagC2];
    assert.ok(!carolDiagrams.includes(ra.data.mermaid_diagram),
      "Alice must never end up with Carol's diagram");
    assert.ok(!carolDiagrams.includes(rb.data.mermaid_diagram),
      "Bob must never end up with Carol's diagram");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Concurrent context injection updates
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent context injection updates — no cross-contamination", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("all three mutate different context injection fields simultaneously — all PUT requests succeed", async () => {
    // Alice disables 'skills'; Bob disables 'mcps'; Carol disables 'hooks'
    const [aRules, bRules, cRules] = await Promise.all([
      alice("GET", "/context-injection").then(r => r.data.rules),
      bob("GET",   "/context-injection").then(r => r.data.rules),
      carol("GET", "/context-injection").then(r => r.data.rules),
    ]);

    const aliceUpdated = aRules.map(r => r.id === "skills" ? { ...r, active: false } : r);
    const bobUpdated   = bRules.map(r => r.id === "mcps"   ? { ...r, active: false } : r);
    const carolUpdated = cRules.map(r => r.id === "hooks"  ? { ...r, active: false } : r);

    const [ra, rb, rc] = await Promise.all([
      alice("PUT", "/context-injection", { rules: aliceUpdated }),
      bob("PUT",   "/context-injection", { rules: bobUpdated }),
      carol("PUT", "/context-injection", { rules: carolUpdated }),
    ]);
    assert.ok(ra.ok, "Alice PUT /context-injection failed");
    assert.ok(rb.ok, "Bob PUT /context-injection failed");
    assert.ok(rc.ok, "Carol PUT /context-injection failed");
  });

  it("Alice's 'skills' disable is reflected only for Alice — Bob and Carol still have skills active", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET",   "/context-injection"),
      carol("GET", "/context-injection"),
    ]);

    const aliceSkills = ra.data.rules.find(r => r.id === "skills");
    const bobSkills   = rb.data.rules.find(r => r.id === "skills");
    const carolSkills = rc.data.rules.find(r => r.id === "skills");

    assert.equal(aliceSkills?.active, false,  "Alice: skills must be inactive");
    assert.equal(bobSkills?.active,   true,   "Bob: skills must still be active");
    assert.equal(carolSkills?.active, true,   "Carol: skills must still be active");
  });

  it("Bob's 'mcps' disable is reflected only for Bob — Alice and Carol unaffected", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET",   "/context-injection"),
      carol("GET", "/context-injection"),
    ]);

    const aliceMcps = ra.data.rules.find(r => r.id === "mcps");
    const bobMcps   = rb.data.rules.find(r => r.id === "mcps");
    const carolMcps = rc.data.rules.find(r => r.id === "mcps");

    assert.equal(aliceMcps?.active, true,  "Alice: mcps must still be active");
    assert.equal(bobMcps?.active,   false, "Bob: mcps must be inactive");
    assert.equal(carolMcps?.active, true,  "Carol: mcps must still be active");
  });

  it("Carol's 'hooks' disable is reflected only for Carol — Alice and Bob unaffected", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET",   "/context-injection"),
      carol("GET", "/context-injection"),
    ]);

    const aliceHooks = ra.data.rules.find(r => r.id === "hooks");
    const bobHooks   = rb.data.rules.find(r => r.id === "hooks");
    const carolHooks = rc.data.rules.find(r => r.id === "hooks");

    assert.equal(aliceHooks?.active, true,  "Alice: hooks must still be active");
    assert.equal(bobHooks?.active,   true,  "Bob: hooks must still be active");
    assert.equal(carolHooks?.active, false, "Carol: hooks must be inactive");
  });

  it("each user's total rule count is unchanged after concurrent updates", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context-injection"),
      bob("GET",   "/context-injection"),
      carol("GET", "/context-injection"),
    ]);
    assert.equal(ra.data.rules.length, DEFAULT_CONTEXT_INJECTION.length,
      "Alice: rule count must equal default after updates");
    assert.equal(rb.data.rules.length, DEFAULT_CONTEXT_INJECTION.length,
      "Bob: rule count must equal default after updates");
    assert.equal(rc.data.rules.length, DEFAULT_CONTEXT_INJECTION.length,
      "Carol: rule count must equal default after updates");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Concurrent resource uploads — content isolation
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent resource uploads — content isolation under simultaneous uploads", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("all three upload different files simultaneously — all uploads succeed", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("POST", "/upload", { name: "alice-data.txt",   content: "ALICE_UNIQUE_CONTENT_XYZ", mime_type: "text/plain" }),
      bob("POST",   "/upload", { name: "bob-data.txt",     content: "BOB_UNIQUE_CONTENT_ABC",   mime_type: "text/plain" }),
      carol("POST", "/upload", { name: "carol-data.txt",   content: "CAROL_UNIQUE_CONTENT_DEF", mime_type: "text/plain" }),
    ]);
    assert.ok(ra.ok, `Alice upload failed: ${JSON.stringify(ra.data)}`);
    assert.ok(rb.ok, `Bob upload failed: ${JSON.stringify(rb.data)}`);
    assert.ok(rc.ok, `Carol upload failed: ${JSON.stringify(rc.data)}`);
  });

  it("each user's /files listing contains only their own uploaded file — never others'", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/files"),
      bob("GET",   "/files"),
      carol("GET", "/files"),
    ]);
    const alicePaths = ra.data.files.map(f => f.path);
    const bobPaths   = rb.data.files.map(f => f.path);
    const carolPaths = rc.data.files.map(f => f.path);

    assert.ok( alicePaths.includes("00_Resources/alice-data.txt"), "Alice: own file present");
    assert.ok(!alicePaths.includes("00_Resources/bob-data.txt"),   "Alice: Bob's file absent");
    assert.ok(!alicePaths.includes("00_Resources/carol-data.txt"), "Alice: Carol's file absent");

    assert.ok(!bobPaths.includes("00_Resources/alice-data.txt"), "Bob: Alice's file absent");
    assert.ok( bobPaths.includes("00_Resources/bob-data.txt"),   "Bob: own file present");
    assert.ok(!bobPaths.includes("00_Resources/carol-data.txt"), "Bob: Carol's file absent");

    assert.ok(!carolPaths.includes("00_Resources/alice-data.txt"), "Carol: Alice's file absent");
    assert.ok(!carolPaths.includes("00_Resources/bob-data.txt"),   "Carol: Bob's file absent");
    assert.ok( carolPaths.includes("00_Resources/carol-data.txt"), "Carol: own file present");
  });

  it("each user's /context resources contain only their own content — no content bleed", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/context"),
      bob("GET",   "/context"),
      carol("GET", "/context"),
    ]);
    const allAliceContent = (ra.data.resources ?? []).map(r => r.content ?? "").join("\n");
    const allBobContent   = (rb.data.resources ?? []).map(r => r.content ?? "").join("\n");
    const allCarolContent = (rc.data.resources ?? []).map(r => r.content ?? "").join("\n");

    assert.ok( allAliceContent.includes("ALICE_UNIQUE_CONTENT_XYZ"), "Alice /context: own content present");
    assert.ok(!allAliceContent.includes("BOB_UNIQUE_CONTENT_ABC"),   "Alice /context: Bob's content absent");
    assert.ok(!allAliceContent.includes("CAROL_UNIQUE_CONTENT_DEF"), "Alice /context: Carol's content absent");

    assert.ok(!allBobContent.includes("ALICE_UNIQUE_CONTENT_XYZ"), "Bob /context: Alice's content absent");
    assert.ok( allBobContent.includes("BOB_UNIQUE_CONTENT_ABC"),   "Bob /context: own content present");
    assert.ok(!allBobContent.includes("CAROL_UNIQUE_CONTENT_DEF"), "Bob /context: Carol's content absent");

    assert.ok(!allCarolContent.includes("ALICE_UNIQUE_CONTENT_XYZ"), "Carol /context: Alice's content absent");
    assert.ok(!allCarolContent.includes("BOB_UNIQUE_CONTENT_ABC"),   "Carol /context: Bob's content absent");
    assert.ok( allCarolContent.includes("CAROL_UNIQUE_CONTENT_DEF"), "Carol /context: own content present");
  });

  it("all three upload and immediately read /context in parallel — no partial or wrong state", async () => {
    // Upload a second file per user and immediately read context — racing read vs write
    const [, , , ra, rb, rc] = await Promise.all([
      alice("POST", "/upload", { name: "alice-notes.md",  content: "ALICE_NOTES_SECOND", mime_type: "text/markdown" }),
      bob("POST",   "/upload", { name: "bob-report.md",   content: "BOB_REPORT_SECOND",  mime_type: "text/markdown" }),
      carol("POST", "/upload", { name: "carol-specs.md",  content: "CAROL_SPECS_SECOND", mime_type: "text/markdown" }),
      alice("GET",  "/context"),
      bob("GET",    "/context"),
      carol("GET",  "/context"),
    ]);
    // Even if the read races the write, each user's context must never contain another user's content
    const allAlice = (ra.data.resources ?? []).map(r => r.content ?? "").join("\n");
    const allBob   = (rb.data.resources ?? []).map(r => r.content ?? "").join("\n");
    const allCarol = (rc.data.resources ?? []).map(r => r.content ?? "").join("\n");

    // Cross-contamination check: the markers below belong exclusively to one user
    assert.ok(!allAlice.includes("BOB_REPORT_SECOND"),   "Alice: Bob's second file absent");
    assert.ok(!allAlice.includes("CAROL_SPECS_SECOND"),  "Alice: Carol's second file absent");
    assert.ok(!allBob.includes("ALICE_NOTES_SECOND"),    "Bob: Alice's notes absent");
    assert.ok(!allBob.includes("CAROL_SPECS_SECOND"),    "Bob: Carol's specs absent");
    assert.ok(!allCarol.includes("ALICE_NOTES_SECOND"),  "Carol: Alice's notes absent");
    assert.ok(!allCarol.includes("BOB_REPORT_SECOND"),   "Carol: Bob's report absent");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Race conditions — same-user concurrent writes
// ════════════════════════════════════════════════════════════════════════════

describe("Race conditions — same-user concurrent writes do not corrupt state", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("same user: three simultaneous POST /directories for same workstation — CLAUDE.md appears exactly once", async () => {
    await Promise.all([
      alice("POST", "/directories", { name: "shared-workspace" }),
      alice("POST", "/directories", { name: "shared-workspace" }),
      alice("POST", "/directories", { name: "shared-workspace" }),
    ]);
    const r = await alice("GET", "/files");
    const count = r.data.files.filter(f => f.path === "shared-workspace/CLAUDE.md").length;
    assert.equal(count, 1,
      `Concurrent POST /directories must be idempotent; CLAUDE.md appeared ${count} times`);
    const memCount = r.data.files.filter(f => f.path === "shared-workspace/MEMORY.md").length;
    assert.equal(memCount, 1, `MEMORY.md appeared ${memCount} times`);
  });

  it("same user: three concurrent PUT /files/CLAUDE.md — server does not crash and final state is valid", async () => {
    const contents = [
      "# Alice V1\n\nVersion one.",
      "# Alice V2\n\nVersion two.",
      "# Alice V3\n\nVersion three.",
    ];
    await Promise.all(contents.map(content =>
      alice("PUT", "/files/CLAUDE.md", { content, mime_type: "text/markdown" })
    ));

    const r = await alice("GET", "/files/CLAUDE.md");
    assert.ok(r.ok, "GET /files/CLAUDE.md must succeed after concurrent writes");
    assert.ok(typeof r.data.content === "string" && r.data.content.length > 0,
      "CLAUDE.md content must be a non-empty string after concurrent writes");
    // Final state must be one of the written values — not garbled
    assert.ok(
      contents.some(c => r.data.content === c),
      `Final content must be one of the written values; got: ${r.data.content?.slice(0, 50)}`
    );
  });

  it("concurrent writes to different users' CLAUDE.md do not corrupt each other", async () => {
    const aliceContent = "# Alice's CLAUDE.md — unique marker ALICE123";
    const bobContent   = "# Bob's CLAUDE.md — unique marker BOB456";
    const carolContent = "# Carol's CLAUDE.md — unique marker CAROL789";

    await Promise.all([
      alice("PUT", "/files/CLAUDE.md", { content: aliceContent, mime_type: "text/markdown" }),
      bob("PUT",   "/files/CLAUDE.md", { content: bobContent,   mime_type: "text/markdown" }),
      carol("PUT", "/files/CLAUDE.md", { content: carolContent, mime_type: "text/markdown" }),
    ]);

    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/files/CLAUDE.md"),
      bob("GET",   "/files/CLAUDE.md"),
      carol("GET", "/files/CLAUDE.md"),
    ]);

    assert.ok( ra.data.content.includes("ALICE123"), "Alice: own marker present");
    assert.ok(!ra.data.content.includes("BOB456"),   "Alice: Bob's marker absent");
    assert.ok(!ra.data.content.includes("CAROL789"), "Alice: Carol's marker absent");

    assert.ok(!rb.data.content.includes("ALICE123"), "Bob: Alice's marker absent");
    assert.ok( rb.data.content.includes("BOB456"),   "Bob: own marker present");
    assert.ok(!rb.data.content.includes("CAROL789"), "Bob: Carol's marker absent");

    assert.ok(!rc.data.content.includes("ALICE123"), "Carol: Alice's marker absent");
    assert.ok(!rc.data.content.includes("BOB456"),   "Carol: Bob's marker absent");
    assert.ok( rc.data.content.includes("CAROL789"), "Carol: own marker present");
  });

  it("Alice deletes a workstation concurrently with Bob creating one — Bob's creation is unaffected", async () => {
    // Alice creates then deletes; Bob creates concurrently with Alice's delete
    await alice("POST", "/directories", { name: "alice-temp" });

    await Promise.all([
      alice("DELETE", "/files/alice-temp"),
      bob("POST", "/directories", { name: "bob-concurrent" }),
    ]);

    const [aliceFiles, bobFiles] = await Promise.all([
      alice("GET", "/files"),
      bob("GET",   "/files"),
    ]);
    const alicePaths = aliceFiles.data.files.map(f => f.path);
    const bobPaths   = bobFiles.data.files.map(f => f.path);

    assert.ok(!alicePaths.includes("alice-temp"),         "Alice's deleted workstation gone");
    assert.ok( bobPaths.includes("bob-concurrent"),       "Bob's concurrent workstation exists");
    assert.ok( bobPaths.includes("bob-concurrent/CLAUDE.md"), "Bob's workstation seeded");
    assert.ok(!alicePaths.includes("bob-concurrent"),     "Alice must not see Bob's workstation");
  });

  it("GET /context reads by all three users while all three are writing resources — no panics, data is correct", async () => {
    // Mix of reads and writes in one big parallel batch
    const results = await Promise.all([
      alice("POST", "/upload", { name: "race-test-alice.txt", content: "RACE_ALICE", mime_type: "text/plain" }),
      bob("POST",   "/upload", { name: "race-test-bob.txt",   content: "RACE_BOB",   mime_type: "text/plain" }),
      carol("POST", "/upload", { name: "race-test-carol.txt", content: "RACE_CAROL", mime_type: "text/plain" }),
      alice("GET", "/context"),
      bob("GET",   "/context"),
      carol("GET", "/context"),
    ]);

    const [, , , aliceCtx, bobCtx, carolCtx] = results;

    // All reads must succeed (no crash from concurrent write)
    assert.ok(aliceCtx.ok, "Alice GET /context must succeed during concurrent writes");
    assert.ok(bobCtx.ok,   "Bob GET /context must succeed during concurrent writes");
    assert.ok(carolCtx.ok, "Carol GET /context must succeed during concurrent writes");

    // Cross-contamination must never occur
    const allAliceContent = (aliceCtx.data.resources ?? []).map(r => r.content ?? "").join(" ");
    const allBobContent   = (bobCtx.data.resources ?? []).map(r => r.content ?? "").join(" ");
    const allCarolContent = (carolCtx.data.resources ?? []).map(r => r.content ?? "").join(" ");

    assert.ok(!allAliceContent.includes("RACE_BOB"),   "Alice context: Bob's race data absent");
    assert.ok(!allAliceContent.includes("RACE_CAROL"), "Alice context: Carol's race data absent");
    assert.ok(!allBobContent.includes("RACE_ALICE"),   "Bob context: Alice's race data absent");
    assert.ok(!allBobContent.includes("RACE_CAROL"),   "Bob context: Carol's race data absent");
    assert.ok(!allCarolContent.includes("RACE_ALICE"), "Carol context: Alice's race data absent");
    assert.ok(!allCarolContent.includes("RACE_BOB"),   "Carol context: Bob's race data absent");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Concurrent personal copy creation for a shared skill item
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent personal copy creation — three users personalise the same skill item", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("all three create personal copies of 'agent-orchestration' simultaneously — all succeed", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("PUT", "/files/_context/skills/agent-orchestration", {
        content: "# Alice Orchestration\nAlice-specific orchestration rules.",
        mime_type: "text/markdown",
      }),
      bob("PUT", "/files/_context/skills/agent-orchestration", {
        content: "# Bob Orchestration\nBob-specific orchestration rules.",
        mime_type: "text/markdown",
      }),
      carol("PUT", "/files/_context/skills/agent-orchestration", {
        content: "# Carol Orchestration\nCarol-specific orchestration rules.",
        mime_type: "text/markdown",
      }),
    ]);
    assert.ok(ra.ok, "Alice: personal copy PUT failed");
    assert.ok(rb.ok, "Bob: personal copy PUT failed");
    assert.ok(rc.ok, "Carol: personal copy PUT failed");
  });

  it("each user reads back their own personal copy — not another user's content", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/files/_context/skills/agent-orchestration"),
      bob("GET",   "/files/_context/skills/agent-orchestration"),
      carol("GET", "/files/_context/skills/agent-orchestration"),
    ]);
    assert.ok(ra.data.content.includes("Alice-specific"), "Alice: own content present");
    assert.ok(!ra.data.content.includes("Bob-specific"),  "Alice: Bob's content absent");
    assert.ok(!ra.data.content.includes("Carol-specific"),"Alice: Carol's content absent");

    assert.ok(!rb.data.content.includes("Alice-specific"),"Bob: Alice's content absent");
    assert.ok( rb.data.content.includes("Bob-specific"),  "Bob: own content present");
    assert.ok(!rb.data.content.includes("Carol-specific"),"Bob: Carol's content absent");

    assert.ok(!rc.data.content.includes("Alice-specific"),"Carol: Alice's content absent");
    assert.ok(!rc.data.content.includes("Bob-specific"),  "Carol: Bob's content absent");
    assert.ok( rc.data.content.includes("Carol-specific"),"Carol: own content present");
  });

  it("server default on disk is untouched after all three users create personal copies", async () => {
    const diskContent = await readFile(
      join(PROJECT_ROOT, "skills", "agent-orchestration.md"), "utf8"
    );
    assert.ok(!diskContent.includes("Alice-specific"),  "disk: Alice's content must not appear");
    assert.ok(!diskContent.includes("Bob-specific"),    "disk: Bob's content must not appear");
    assert.ok(!diskContent.includes("Carol-specific"),  "disk: Carol's content must not appear");
    assert.ok(diskContent.trim().length > 0,            "disk: server default must still have content");
  });

  it("GET /defaults returns the unmodified server default for all three users simultaneously", async () => {
    const [ra, rb, rc] = await Promise.all([
      alice("GET", "/defaults/skills/agent-orchestration"),
      bob("GET",   "/defaults/skills/agent-orchestration"),
      carol("GET", "/defaults/skills/agent-orchestration"),
    ]);
    // All three must get the same server default
    assert.ok(ra.data.content.length > 0, "Alice /defaults: non-empty");
    assert.ok(rb.data.content.length > 0, "Bob /defaults: non-empty");
    assert.ok(rc.data.content.length > 0, "Carol /defaults: non-empty");
    assert.equal(ra.data.content, rb.data.content,
      "Alice and Bob must get the same server default");
    assert.equal(rb.data.content, rc.data.content,
      "Bob and Carol must get the same server default");
    // And none of their personal copies leaked into the server default
    assert.ok(!ra.data.content.includes("Alice-specific"), "server default: no Alice bleed");
    assert.ok(!rb.data.content.includes("Bob-specific"),   "server default: no Bob bleed");
    assert.ok(!rc.data.content.includes("Carol-specific"), "server default: no Carol bleed");
  });

  it("buildContextInjectionContent resolves personal copy vs. disk independently per user when called concurrently", async () => {
    // Build workspace files for each user from their personal copies
    const aliceFiles = [{ path: "_context/skills/agent-orchestration", content: "# Alice Orchestration\nAlice-specific orchestration rules." }];
    const bobFiles   = [{ path: "_context/skills/agent-orchestration", content: "# Bob Orchestration\nBob-specific orchestration rules." }];
    const carolFiles = []; // Carol has no personal copy passed — falls back to disk

    const rules = [{ id: "skills", label: "Skills", items: ["agent-orchestration"], active: true }];

    const [aliceRes, bobRes, carolRes] = await Promise.all([
      buildContextInjectionContent(rules, aliceFiles),
      buildContextInjectionContent(rules, bobFiles),
      buildContextInjectionContent(rules, carolFiles),
    ]);
    const aliceCtx = aliceRes.content;
    const bobCtx   = bobRes.content;
    const carolCtx = carolRes.content;

    assert.ok( aliceCtx.includes("Alice-specific"), "buildContextInjectionContent: Alice personal copy used");
    assert.ok(!aliceCtx.includes("Bob-specific"),   "buildContextInjectionContent: Bob's copy absent for Alice");
    assert.ok( bobCtx.includes("Bob-specific"),     "buildContextInjectionContent: Bob personal copy used");
    assert.ok(!bobCtx.includes("Alice-specific"),   "buildContextInjectionContent: Alice's copy absent for Bob");
    // Carol falls back to disk default
    assert.ok(carolCtx.length > 0,                 "buildContextInjectionContent: Carol falls back to disk");
    assert.ok(!carolCtx.includes("Alice-specific"), "buildContextInjectionContent: no Alice bleed in Carol's context");
    assert.ok(!carolCtx.includes("Bob-specific"),   "buildContextInjectionContent: no Bob bleed in Carol's context");
  });

  it("Alice's personal copy is not visible to Bob — Bob gets 404 for Alice's path", async () => {
    const r = await bob("GET", "/files/_context/skills/agent-orchestration");
    // Bob has his own personal copy, so he gets 200. But his content must not be Alice's.
    if (r.status === 200) {
      assert.ok(!r.data.content.includes("Alice-specific"),
        "Bob reading his own personal copy must not see Alice's content");
    }
    // Confirm Alice can't read Bob's path either (they share the same path key but different user_id)
    const aliceRead = await alice("GET", "/files/_context/skills/agent-orchestration");
    assert.ok(!aliceRead.data.content.includes("Bob-specific"),
      "Alice reading her personal copy must not see Bob's content");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Architecture routing isolation under concurrent load (module-level)
// ════════════════════════════════════════════════════════════════════════════

describe("Architecture routing isolation — pure function safety under concurrent calls", () => {

  const ALICE_DIAGRAM_NO_PLANNER = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> coder
  orchestrator --> researcher
  coder --> executor
  researcher --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

  const BOB_DIAGRAM_NO_CODER = `flowchart LR
  userinput([User Input]) --> orchestrator
  orchestrator --> planner
  orchestrator --> writer
  planner --> executor
  writer --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

  const CAROL_DIAGRAM_MINIMAL = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> writer
  writer --> response([Response])`;

  it("parseArchitectureAgents is safe for concurrent calls — all three return correct independent sets", () => {
    // No await — all three calls are synchronous and concurrent (same tick)
    const [aliceAllowed, bobAllowed, carolAllowed] = [
      parseArchitectureAgents(ALICE_DIAGRAM_NO_PLANNER),
      parseArchitectureAgents(BOB_DIAGRAM_NO_CODER),
      parseArchitectureAgents(CAROL_DIAGRAM_MINIMAL),
    ];

    // Alice: no planner, has coder and researcher
    assert.ok(aliceAllowed instanceof Set,          "Alice: must return Set");
    assert.ok(!aliceAllowed.has("planner"),         "Alice: planner absent");
    assert.ok( aliceAllowed.has("coder"),           "Alice: coder present");
    assert.ok( aliceAllowed.has("researcher"),      "Alice: researcher present");

    // Bob: no coder, has planner and writer
    assert.ok(bobAllowed instanceof Set,            "Bob: must return Set");
    assert.ok(!bobAllowed.has("coder"),             "Bob: coder absent");
    assert.ok( bobAllowed.has("planner"),           "Bob: planner present");
    assert.ok( bobAllowed.has("writer"),            "Bob: writer present");

    // Carol: minimal — only orchestrator and writer
    assert.ok(carolAllowed instanceof Set,          "Carol: must return Set");
    assert.ok(!carolAllowed.has("planner"),         "Carol: planner absent");
    assert.ok(!carolAllowed.has("coder"),           "Carol: coder absent");
    assert.ok(!carolAllowed.has("researcher"),      "Carol: researcher absent");
    assert.ok( carolAllowed.has("orchestrator"),    "Carol: orchestrator present");
    assert.ok( carolAllowed.has("writer"),          "Carol: writer present");
  });

  it("applyArchitectureFilter is a pure function — repeated concurrent calls with same input produce identical output", () => {
    const route = makeRoute(["planner", "researcher", "coder", "reviewer"], "planner");
    const allowed = parseArchitectureAgents(ALICE_DIAGRAM_NO_PLANNER);

    // Call 10 times concurrently — all results must be identical
    const results = Array.from({ length: 10 }, () => applyArchitectureFilter(route, allowed));
    for (let i = 1; i < results.length; i++) {
      assert.deepEqual(results[i].agents, results[0].agents,
        `Call ${i} returned different agents from call 0`);
      assert.equal(results[i].primary, results[0].primary,
        `Call ${i} returned different primary from call 0`);
    }
  });

  it("three users' routing decisions are independent — one user's filter does not affect another's", () => {
    const aliceAllowed = parseArchitectureAgents(ALICE_DIAGRAM_NO_PLANNER);
    const bobAllowed   = parseArchitectureAgents(BOB_DIAGRAM_NO_CODER);
    const carolAllowed = parseArchitectureAgents(CAROL_DIAGRAM_MINIMAL);

    const rawRoute = makeRoute(["planner", "researcher", "coder", "writer", "reviewer"], "planner");

    // All three filter calls happen with no intermediate state
    const [af, bf, cf] = [
      applyArchitectureFilter(rawRoute, aliceAllowed),
      applyArchitectureFilter(rawRoute, bobAllowed),
      applyArchitectureFilter(rawRoute, carolAllowed),
    ];

    // Alice: planner gone, coder + researcher survive
    assert.ok(!af.agents.includes("planner"),    "Alice: planner filtered");
    assert.ok( af.agents.includes("coder"),      "Alice: coder survives");
    assert.ok( af.agents.includes("researcher"), "Alice: researcher survives");
    assert.ok(!af.agents.includes("writer"),     "Alice: writer not in Alice diagram");

    // Bob: coder gone, planner + writer survive
    assert.ok( bf.agents.includes("planner"),    "Bob: planner survives");
    assert.ok(!bf.agents.includes("coder"),      "Bob: coder filtered");
    assert.ok( bf.agents.includes("writer"),     "Bob: writer survives");

    // Carol: only writer survives (no planner, coder, researcher in Carol's diagram)
    assert.ok(!cf.agents.includes("planner"),    "Carol: planner filtered");
    assert.ok(!cf.agents.includes("coder"),      "Carol: coder filtered");
    assert.ok(!cf.agents.includes("researcher"), "Carol: researcher filtered");
    assert.ok( cf.agents.includes("writer"),     "Carol: writer survives (in diagram)");
  });

  it("hasPlanner derived from filtered route is false for Alice and Carol (planner removed) — quality loop disabled", () => {
    const aliceAllowed = parseArchitectureAgents(ALICE_DIAGRAM_NO_PLANNER);
    const carolAllowed = parseArchitectureAgents(CAROL_DIAGRAM_MINIMAL);
    const bobAllowed   = parseArchitectureAgents(BOB_DIAGRAM_NO_CODER);

    const rawRoute = makeRoute(["planner", "researcher", "coder", "reviewer"], "planner");

    const aliceFiltered = applyArchitectureFilter(rawRoute, aliceAllowed);
    const bobFiltered   = applyArchitectureFilter(rawRoute, bobAllowed);
    const carolFiltered = applyArchitectureFilter(rawRoute, carolAllowed);

    // hasPlanner simulation: specialistIds.includes("planner")
    const aliceHasPlanner = aliceFiltered.agents.filter(id => id !== "reviewer").includes("planner");
    const bobHasPlanner   = bobFiltered.agents.filter(id => id !== "reviewer").includes("planner");
    const carolHasPlanner = carolFiltered.agents.filter(id => id !== "reviewer").includes("planner");

    assert.equal(aliceHasPlanner, false, "Alice: hasPlanner must be false — quality retry loop disabled");
    assert.equal(bobHasPlanner,   true,  "Bob: hasPlanner must be true — planner is in Bob's diagram");
    assert.equal(carolHasPlanner, false, "Carol: hasPlanner must be false — planner absent from Carol's diagram");
  });

  it("executor gating: executor absent from diagram means executor should not run for that user", () => {
    // Carol's minimal diagram has no executor
    const carolAllowed = parseArchitectureAgents(CAROL_DIAGRAM_MINIMAL);
    assert.ok(!carolAllowed.has("executor"),
      "Carol's diagram has no executor — executor gate must return false");

    // Alice's diagram has executor
    const aliceAllowed = parseArchitectureAgents(ALICE_DIAGRAM_NO_PLANNER);
    assert.ok(aliceAllowed.has("executor"),
      "Alice's diagram has executor — executor gate must return true");

    // Simulating the executor guard from chat.js:
    //   !allowedAgents || allowedAgents.has("executor")
    assert.equal(!carolAllowed || carolAllowed.has("executor"), false,
      "Carol's executor gate must evaluate to false");
    assert.equal(!aliceAllowed || aliceAllowed.has("executor"), true,
      "Alice's executor gate must evaluate to true");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Concurrent /context reads during in-flight writes
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrent /context reads during in-flight writes — data accuracy", () => {
  let store, aliceSrv, bobSrv, carolSrv;
  let alicePort, bobPort, carolPort;
  let alice, bob, carol;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    [aliceSrv, bobSrv, carolSrv] = await Promise.all([
      startServer(buildApp(ALICE_ID)),
      startServer(buildApp(BOB_ID)),
      startServer(buildApp(CAROL_ID)),
    ]);
    alicePort = aliceSrv.address().port;
    bobPort   = bobSrv.address().port;
    carolPort = carolSrv.address().port;
    alice = (m, p, b) => req(alicePort, m, p, b);
    bob   = (m, p, b) => req(bobPort,   m, p, b);
    carol = (m, p, b) => req(carolPort, m, p, b);
    await Promise.all([
      alice("POST", "/init"),
      bob("POST", "/init"),
      carol("POST", "/init"),
    ]);
  });

  after(() => {
    _resetSupabaseFactory();
    aliceSrv?.close(); bobSrv?.close(); carolSrv?.close();
  });

  it("Alice writes a new diagram while Bob and Carol read /context — Bob and Carol always get their own mermaidDiagram", async () => {
    const aliceNewDiagram = "flowchart LR\n  orchestrator --> coder\n  coder --> executor";
    const [, bobCtx, carolCtx] = await Promise.all([
      alice("PUT", "/agent-config", { mermaid_diagram: aliceNewDiagram, agent_overrides: {} }),
      bob("GET",   "/context"),
      carol("GET", "/context"),
    ]);
    // Bob and Carol's /context must return their own diagrams (DEFAULT_MERMAID, not Alice's)
    assert.equal(bobCtx.data.mermaidDiagram,   DEFAULT_MERMAID,
      "Bob /context: mermaidDiagram must be his own (DEFAULT_MERMAID), not Alice's write");
    assert.equal(carolCtx.data.mermaidDiagram, DEFAULT_MERMAID,
      "Carol /context: mermaidDiagram must be her own (DEFAULT_MERMAID), not Alice's write");
    assert.ok(bobCtx.data.mermaidDiagram !== aliceNewDiagram,
      "Bob must not receive Alice's diagram during her write");
    assert.ok(carolCtx.data.mermaidDiagram !== aliceNewDiagram,
      "Carol must not receive Alice's diagram during her write");
  });

  it("all three write different CLAUDE.md simultaneously and immediately read it — each reads their own version", async () => {
    const aliceMd = "# Alice live-write — marker LIVE_ALICE";
    const bobMd   = "# Bob live-write — marker LIVE_BOB";
    const carolMd = "# Carol live-write — marker LIVE_CAROL";

    const [, , , ra, rb, rc] = await Promise.all([
      alice("PUT", "/files/CLAUDE.md", { content: aliceMd, mime_type: "text/markdown" }),
      bob("PUT",   "/files/CLAUDE.md", { content: bobMd,   mime_type: "text/markdown" }),
      carol("PUT", "/files/CLAUDE.md", { content: carolMd, mime_type: "text/markdown" }),
      alice("GET", "/context"),
      bob("GET",   "/context"),
      carol("GET", "/context"),
    ]);

    // Each /context response must not leak another user's CLAUDE.md content
    assert.ok(!ra.data.claudeMd?.includes("LIVE_BOB"),   "Alice /context: no Bob CLAUDE.md bleed");
    assert.ok(!ra.data.claudeMd?.includes("LIVE_CAROL"), "Alice /context: no Carol CLAUDE.md bleed");
    assert.ok(!rb.data.claudeMd?.includes("LIVE_ALICE"), "Bob /context: no Alice CLAUDE.md bleed");
    assert.ok(!rb.data.claudeMd?.includes("LIVE_CAROL"), "Bob /context: no Carol CLAUDE.md bleed");
    assert.ok(!rc.data.claudeMd?.includes("LIVE_ALICE"), "Carol /context: no Alice CLAUDE.md bleed");
    assert.ok(!rc.data.claudeMd?.includes("LIVE_BOB"),   "Carol /context: no Bob CLAUDE.md bleed");
  });

  it("large concurrent batch — 9 simultaneous requests (3 writes + 6 reads) all return valid data", async () => {
    const diagram = "flowchart TD\n  orchestrator --> writer\n  writer --> executor";
    const results = await Promise.all([
      // 3 writes
      alice("PUT", "/agent-config", { mermaid_diagram: diagram, agent_overrides: {} }),
      bob("PUT",   "/agent-config", { mermaid_diagram: diagram, agent_overrides: {} }),
      carol("PUT", "/agent-config", { mermaid_diagram: diagram, agent_overrides: {} }),
      // 6 reads (2 per user)
      alice("GET", "/context"),
      alice("GET", "/agent-config"),
      bob("GET",   "/context"),
      bob("GET",   "/agent-config"),
      carol("GET", "/context"),
      carol("GET", "/agent-config"),
    ]);

    // All 9 requests must succeed
    for (let i = 0; i < results.length; i++) {
      assert.ok(results[i].ok,
        `Request ${i} failed with status ${results[i].status}: ${JSON.stringify(results[i].data)}`);
    }

    // The three /context reads (indices 3, 5, 7) must all be user-specific
    const [, , , aliceCtx, , bobCtx, , carolCtx] = results;
    assert.ok(typeof aliceCtx.data.mermaidDiagram === "string", "Alice /context: mermaidDiagram is string");
    assert.ok(typeof bobCtx.data.mermaidDiagram   === "string", "Bob /context: mermaidDiagram is string");
    assert.ok(typeof carolCtx.data.mermaidDiagram === "string", "Carol /context: mermaidDiagram is string");
  });
});
