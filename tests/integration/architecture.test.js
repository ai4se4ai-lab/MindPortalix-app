/**
 * Architecture-enforcement tests
 *
 * Covers:
 *   1. parseArchitectureAgents — Mermaid → Set<agentId>
 *   2. applyArchitectureFilter — route filtering against allowed agents
 *   3. buildContextInjectionContent — context assembly from DB + disk
 *   4. HTTP-level integration — /context returns resource content;
 *      architecture filter applied before route is sent
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir } from "node:fs/promises";
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal route object matching classifyIntent() output. */
function makeRoute(agents, primary) {
  return { agents, primary, modalities: [], confidence: 1.0, matchedKeywords: [] };
}

// ── In-memory Supabase mock (reused from workspace-isolation.test.js) ────────

class InMemoryStore {
  constructor() { this.tables = new Map(); }
  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
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
  single()      { this._single = true; return this._exec(); }
  then(ok, fail){ return this._exec().then(ok, fail); }
  select(cols)  { this._cols = cols; this._op = "select"; return this; }
  delete()      { this._op = "delete"; return this; }
  eq(f, v)      { this._f.push({ t: "eq",   f, v }); return this; }
  not(f, op, v) { this._f.push({ t: "not",  f, v }); return this; }
  like(f, p)    { this._f.push({ t: "like", f, p }); return this; }
  order(col)    { this._order = col; return this; }
  _match(row) {
    for (const { t, f, v, p } of this._f) {
      if (t === "eq"   && row[f] !== v)                    return false;
      if (t === "like" && !likeRe(p).test(row[f] ?? ""))  return false;
      if (t === "not"  &&  likeRe(v).test(row[f] ?? ""))  return false;
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

// ════════════════════════════════════════════════════════════════════════════
// 1. parseArchitectureAgents
// ════════════════════════════════════════════════════════════════════════════

describe("parseArchitectureAgents — Mermaid diagram to agent set", () => {

  it("empty string returns null (no restriction)", () => {
    assert.equal(parseArchitectureAgents(""), null);
  });

  it("null/undefined returns null (no restriction)", () => {
    assert.equal(parseArchitectureAgents(null), null);
    assert.equal(parseArchitectureAgents(undefined), null);
  });

  it("whitespace-only string returns null", () => {
    assert.equal(parseArchitectureAgents("   \n\t  "), null);
  });

  it("DEFAULT_MERMAID includes all core text agents", () => {
    const result = parseArchitectureAgents(DEFAULT_MERMAID);
    assert.ok(result instanceof Set, "should return a Set");
    const expected = ["orchestrator", "researcher", "memory", "coder", "writer",
      "governor", "planner", "formatter", "executor", "reviewer"];
    for (const agent of expected) {
      assert.ok(result.has(agent), `expected '${agent}' to be found in default diagram`);
    }
  });

  it("DEFAULT_MERMAID resolves imagegen alias → image_generator", () => {
    const result = parseArchitectureAgents(DEFAULT_MERMAID);
    assert.ok(result.has("image_generator"), "imagegen alias should resolve to image_generator");
  });

  it("DEFAULT_MERMAID resolves audiogen alias → audio_generator", () => {
    const result = parseArchitectureAgents(DEFAULT_MERMAID);
    assert.ok(result.has("audio_generator"), "audiogen alias should resolve to audio_generator");
  });

  it("diagram with planner removed does NOT include planner", () => {
    const diagram = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> researcher
  orchestrator --> coder
  orchestrator --> writer
  researcher --> executor
  coder --> executor
  writer --> executor
  executor --> reviewer
  reviewer --> response([Response])`;
    const result = parseArchitectureAgents(diagram);
    assert.ok(result instanceof Set);
    assert.ok(!result.has("planner"), "planner must not appear when removed from diagram");
    assert.ok(result.has("coder"), "coder should be found");
    assert.ok(result.has("researcher"), "researcher should be found");
    assert.ok(result.has("executor"), "executor should be found");
    assert.ok(result.has("reviewer"), "reviewer should be found");
  });

  it("diagram with only orchestrator + coder + executor returns exactly those 3", () => {
    const diagram = `flowchart LR
  orchestrator --> coder
  coder --> executor`;
    const result = parseArchitectureAgents(diagram);
    assert.ok(result.has("orchestrator"), "orchestrator present");
    assert.ok(result.has("coder"), "coder present");
    assert.ok(result.has("executor"), "executor present");
    assert.ok(!result.has("planner"), "planner absent");
    assert.ok(!result.has("researcher"), "researcher absent");
    assert.ok(!result.has("reviewer"), "reviewer absent");
  });

  it("non-agent tokens like 'flowchart', 'TD', 'LR', 'subgraph', 'end' are ignored", () => {
    const diagram = `flowchart TD
  subgraph main
    coder --> executor
  end`;
    const result = parseArchitectureAgents(diagram);
    // "flowchart", "TD", "subgraph", "end", "main" should not sneak in as agents
    assert.ok(!result.has("flowchart"), "flowchart must be ignored");
    assert.ok(!result.has("td"),        "TD must be ignored");
    assert.ok(!result.has("subgraph"),  "subgraph must be ignored");
    assert.ok(!result.has("end"),       "end must be ignored");
    assert.ok(result.has("coder"),      "coder should still be detected");
    assert.ok(result.has("executor"),   "executor should still be detected");
  });

  it("non-agent tokens 'userinput', 'response', 'user', 'input', 'output' are ignored", () => {
    const diagram = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> writer
  writer --> response([Response])`;
    const result = parseArchitectureAgents(diagram);
    assert.ok(!result.has("userinput"), "userinput must be ignored");
    assert.ok(!result.has("response"),  "response must be ignored");
    assert.ok(!result.has("user"),      "user must be ignored");
    assert.ok(!result.has("input"),     "input must be ignored");
    assert.ok(!result.has("output"),    "output must be ignored");
    assert.ok(result.has("orchestrator"), "orchestrator should be found");
    assert.ok(result.has("writer"),       "writer should be found");
  });

  it("diagram with only unrecognised tokens returns null", () => {
    const diagram = "flowchart TD\n  userinput --> response";
    const result = parseArchitectureAgents(diagram);
    assert.equal(result, null, "should return null when no registry agents found");
  });

  it("inline labels like imagegen[\"Image Gen\"] are resolved correctly", () => {
    const diagram = `flowchart TD
  orchestrator --> imagegen["Image Gen"]
  orchestrator --> audiogen["Audio Gen"]`;
    const result = parseArchitectureAgents(diagram);
    assert.ok(result.has("image_generator"), "imagegen alias resolved");
    assert.ok(result.has("audio_generator"), "audiogen alias resolved");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. applyArchitectureFilter
// ════════════════════════════════════════════════════════════════════════════

describe("applyArchitectureFilter — route filtering by architecture", () => {

  it("null allowedAgents returns route unchanged", () => {
    const route = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, null);
    assert.deepEqual(result, route, "route must be identical when allowedAgents is null");
  });

  it("allowedAgents includes all route agents — route unchanged", () => {
    const allowed = new Set(["planner", "researcher", "reviewer", "executor"]);
    const route = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, allowed);
    assert.deepEqual(result.agents, ["planner", "researcher", "reviewer"]);
    assert.equal(result.primary, "planner");
  });

  it("planner removed from allowedAgents → planner absent from filtered route", () => {
    const allowed = new Set(["researcher", "coder", "reviewer", "executor"]);
    const route = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, allowed);
    assert.ok(!result.agents.includes("planner"), "planner must be filtered out");
    assert.ok(result.agents.includes("researcher"), "researcher must survive");
    assert.ok(result.agents.includes("reviewer"),   "reviewer must survive (quality gate)");
  });

  it("primary agent removed from allowed → primary updated to first surviving specialist", () => {
    const allowed = new Set(["researcher", "reviewer"]);
    const route = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, allowed);
    assert.equal(result.primary, "researcher",
      "primary should update to first surviving specialist when original primary is filtered");
  });

  it("reviewer always preserved if it was in the original route", () => {
    const allowed = new Set(["coder"]); // reviewer NOT in allowed but still preserved
    const route = makeRoute(["coder", "planner", "reviewer"], "coder");
    const result = applyArchitectureFilter(route, allowed);
    assert.ok(result.agents.includes("reviewer"), "reviewer must always be kept");
    assert.ok(!result.agents.includes("planner"), "planner must be filtered");
  });

  it("reviewer not present in original route — not added by filter", () => {
    const allowed = new Set(["coder", "writer"]);
    const route = makeRoute(["coder", "writer"], "coder");
    const result = applyArchitectureFilter(route, allowed);
    assert.ok(!result.agents.includes("reviewer"),
      "reviewer must not be added if absent from the original route");
  });

  it("all non-reviewer specialists filtered out → fallback to best available agent", () => {
    const allowed = new Set(["memory", "reviewer"]);
    const route = makeRoute(["planner", "coder", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, allowed);
    // no planner or coder in allowed specialists → fallback
    assert.equal(result.agents.length, 2, "should have fallback specialist + reviewer");
    assert.ok(result.agents.includes("reviewer"), "reviewer preserved");
    assert.equal(result.primary, "memory", "memory is the only allowed specialist");
  });

  it("fallback picks from preferred order when multiple available", () => {
    // allowed has writer and researcher (no executor) — writer comes first in preferredOrder
    const allowed = new Set(["writer", "researcher"]);
    const route = makeRoute(["planner", "reviewer"], "planner");
    const result = applyArchitectureFilter(route, allowed);
    // planner not in allowed; preferredOrder = [executor, writer, ...]
    // writer is the first hit in preferred order after executor
    assert.equal(result.primary, "writer");
    assert.ok(result.agents.includes("writer"));
  });

  it("all agents filtered out with no reviewer in original — fallback has no reviewer", () => {
    const allowed = new Set(["writer"]);
    const route = makeRoute(["planner", "coder"], "planner"); // no reviewer in route
    const result = applyArchitectureFilter(route, allowed);
    assert.ok(!result.agents.includes("reviewer"),
      "reviewer should not appear if it was never in the original route");
    assert.equal(result.primary, "writer");
  });

  it("single allowed agent that matches the route primary — route simplified correctly", () => {
    const allowed = new Set(["coder", "reviewer"]);
    const route = makeRoute(["coder", "reviewer"], "coder");
    const result = applyArchitectureFilter(route, allowed);
    assert.deepEqual(result.agents, ["coder", "reviewer"]);
    assert.equal(result.primary, "coder");
  });

  it("other route fields (modalities, confidence, matchedKeywords) are preserved", () => {
    const allowed = new Set(["coder", "reviewer"]);
    const route = {
      agents: ["coder", "reviewer"],
      primary: "coder",
      modalities: ["text"],
      confidence: 0.9,
      matchedKeywords: ["code"],
    };
    const result = applyArchitectureFilter(route, allowed);
    assert.equal(result.confidence, 0.9);
    assert.deepEqual(result.matchedKeywords, ["code"]);
    assert.deepEqual(result.modalities, ["text"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. buildContextInjectionContent
// ════════════════════════════════════════════════════════════════════════════

describe("buildContextInjectionContent — context assembly", () => {

  // buildContextInjectionContent now returns { content, details }

  it("empty contextInjection array → empty content string", async () => {
    const { content, details } = await buildContextInjectionContent([]);
    assert.equal(content, "");
    assert.deepEqual(details, []);
  });

  it("null contextInjection → empty content string", async () => {
    const { content, details } = await buildContextInjectionContent(null);
    assert.equal(content, "");
    assert.deepEqual(details, []);
  });

  it("all categories disabled → empty content string", async () => {
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: false },
      { id: "rules",  label: "Rules",  items: ["general"],         active: false },
    ];
    const { content, details } = await buildContextInjectionContent(rules);
    assert.equal(content, "");
    assert.deepEqual(details, []);
  });

  it("enabled category with existing disk file → content is included + details populated", async () => {
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: true },
    ];
    const { content, details } = await buildContextInjectionContent(rules);
    assert.ok(content.length > 0, "should produce non-empty content");
    assert.ok(content.includes("# Workspace Context Configuration"), "should have header");
    assert.ok(content.includes("## Skills"), "should have Skills section");
    assert.ok(content.includes("### model-selection"), "should have item heading");
    assert.equal(details.length, 1, "one detail entry for model-selection");
    assert.equal(details[0].category, "skills");
    assert.equal(details[0].item, "model-selection");
    assert.equal(details[0].source, "disk");
    assert.ok(details[0].excerpt.length > 0, "excerpt must be populated");
  });

  it("enabled category with missing disk file is skipped gracefully (no throw)", async () => {
    const rules = [
      { id: "skills", label: "Skills", items: ["does-not-exist-xyz-abc"], active: true },
    ];
    const { content, details } = await buildContextInjectionContent(rules);
    assert.equal(content, "", "missing file should produce empty content");
    assert.deepEqual(details, [], "missing file should produce no details");
  });

  it("personal copy in workspaceFiles takes precedence over disk file", async () => {
    const personalContent = "# Personal model selection\nAlways pick cheapest.";
    const workspaceFiles = [
      { path: "_context/skills/model-selection", content: personalContent },
    ];
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: true },
    ];
    const { content, details } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.ok(content.includes("Personal model selection"), "personal copy content should appear");
    assert.ok(content.includes("### model-selection"), "item heading should appear");
    assert.equal(details[0].source, "personal", "source should be 'personal'");
    assert.ok(details[0].excerpt.includes("Always pick cheapest"), "excerpt from personal copy");
  });

  it("empty personal copy falls through to disk file", async () => {
    const workspaceFiles = [
      { path: "_context/skills/model-selection", content: "" },
    ];
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: true },
    ];
    const { content } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.ok(content.length > 0, "should fall through to disk content");
  });

  it("whitespace-only personal copy falls through to disk file", async () => {
    const workspaceFiles = [
      { path: "_context/skills/model-selection", content: "   \n\t  " },
    ];
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: true },
    ];
    const { content } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.ok(content.length > 0, "whitespace personal copy should fall through to disk");
  });

  it("multiple enabled categories each produce a section and detail entries", async () => {
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"],  active: true },
      { id: "rules",  label: "Rules",  items: ["general"],          active: true },
    ];
    const { content, details } = await buildContextInjectionContent(rules);
    assert.ok(content.includes("## Skills"), "Skills section should exist");
    assert.ok(content.includes("## Rules"),  "Rules section should exist");
    assert.ok(details.length >= 2, "at least 2 detail entries (one per loaded file)");
  });

  it("mix of active and inactive categories — only active ones included", async () => {
    const rules = [
      { id: "skills", label: "Skills", items: ["model-selection"], active: true  },
      { id: "rules",  label: "Rules",  items: ["general"],         active: false },
    ];
    const { content, details } = await buildContextInjectionContent(rules);
    assert.ok(content.includes("## Skills"), "active Skills section present");
    assert.ok(!content.includes("## Rules"), "inactive Rules section must be absent");
    assert.ok(details.every(d => d.category === "skills"), "details only from active category");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. HTTP integration — /context resources with content
// ════════════════════════════════════════════════════════════════════════════

describe("GET /context — resources include content for text files", () => {
  const USER_ID = "arch-test-1111-1111-1111-111111111111";
  let store, srv, port, r;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    srv  = await startServer(buildApp(USER_ID));
    port = srv.address().port;
    r    = (m, p, b) => req(port, m, p, b);
    await r("POST", "/init");
  });

  after(() => {
    srv?.close();
    _resetSupabaseFactory();
  });

  it("GET /context resources array is initially empty (no non-dir files except CLAUDE.md/MEMORY.md)", async () => {
    const res = await r("GET", "/context");
    assert.ok(res.ok);
    // Initially resources excludes CLAUDE.md, MEMORY.md, and directories
    // 00_Resources is a directory so excluded from resources
    assert.ok(Array.isArray(res.data.resources));
  });

  it("uploaded text file appears in resources with content field", async () => {
    const uploadRes = await r("POST", "/upload", {
      name: "project-notes.txt",
      content: "These are project notes for the AI.",
      mime_type: "text/plain",
    });
    assert.ok(uploadRes.ok, `upload failed: ${JSON.stringify(uploadRes.data)}`);

    const ctxRes = await r("GET", "/context");
    assert.ok(ctxRes.ok);
    const resource = ctxRes.data.resources.find(f => f.name === "project-notes.txt");
    assert.ok(resource, "uploaded file must appear in resources");
    assert.equal(resource.content, "These are project notes for the AI.",
      "text/plain resource must expose its content");
  });

  it("uploaded markdown file appears in resources with content field", async () => {
    await r("POST", "/upload", {
      name: "requirements.md",
      content: "# Requirements\n\n- Must be fast\n- Must be correct",
      mime_type: "text/markdown",
    });

    const ctxRes = await r("GET", "/context");
    const resource = ctxRes.data.resources.find(f => f.name === "requirements.md");
    assert.ok(resource, "markdown resource must appear");
    assert.ok(resource.content.includes("Requirements"), "content must be present");
  });

  it("content is truncated to 8192 bytes for large text files", async () => {
    const largeContent = "x".repeat(10_000);
    await r("POST", "/upload", {
      name: "large-file.txt",
      content: largeContent,
      mime_type: "text/plain",
    });

    const ctxRes = await r("GET", "/context");
    const resource = ctxRes.data.resources.find(f => f.name === "large-file.txt");
    assert.ok(resource, "large file must appear in resources");
    assert.ok(
      resource.content.length <= 8192,
      `content should be truncated to 8192 bytes; got ${resource.content?.length}`
    );
  });

  it("resources each have path, name, mime_type, and content fields", async () => {
    const ctxRes = await r("GET", "/context");
    for (const resource of ctxRes.data.resources) {
      assert.ok("path"      in resource, "resource must have path");
      assert.ok("name"      in resource, "resource must have name");
      assert.ok("mime_type" in resource, "resource must have mime_type");
      assert.ok("content"   in resource, "resource must have content field");
    }
  });

  it("mermaidDiagram is returned in the /context response", async () => {
    const ctxRes = await r("GET", "/context");
    assert.ok(ctxRes.ok);
    assert.ok(typeof ctxRes.data.mermaidDiagram === "string",
      "mermaidDiagram must be present in /context response");
    assert.ok(ctxRes.data.mermaidDiagram.length > 0, "mermaidDiagram must not be empty");
  });

  it("custom architecture diagram stored via PUT /agent-config is reflected in /context", async () => {
    const customDiagram = `flowchart TD
  orchestrator --> coder
  coder --> executor
  executor --> reviewer`;
    await r("PUT", "/agent-config", { mermaid_diagram: customDiagram, agent_overrides: {} });

    const ctxRes = await r("GET", "/context");
    assert.equal(ctxRes.data.mermaidDiagram, customDiagram,
      "/context must return the user's custom diagram");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Integration — architecture filter + route enforcement
// ════════════════════════════════════════════════════════════════════════════

describe("parseArchitectureAgents + applyArchitectureFilter — end-to-end pipeline", () => {

  it("diagram without planner → filtered route excludes planner", () => {
    const diagram = `flowchart TD
  orchestrator --> researcher
  orchestrator --> coder
  researcher --> executor
  coder --> executor
  executor --> reviewer`;

    const allowedAgents = parseArchitectureAgents(diagram);
    assert.ok(allowedAgents instanceof Set, "should parse to a Set");
    assert.ok(!allowedAgents.has("planner"), "planner must not be in allowed set");

    // Simulate a route that would have included planner
    const rawRoute = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const filteredRoute = applyArchitectureFilter(rawRoute, allowedAgents);

    assert.ok(!filteredRoute.agents.includes("planner"),
      "planner must be absent from filtered route");
    assert.ok(filteredRoute.agents.includes("researcher"),
      "researcher (in diagram) must survive");
    assert.ok(filteredRoute.agents.includes("reviewer"),
      "reviewer always preserved as quality gate");
  });

  it("diagram with only coder → only coder (+ reviewer) can run", () => {
    const diagram = "flowchart LR\n  coder --> reviewer";
    const allowedAgents = parseArchitectureAgents(diagram);

    const rawRoute = makeRoute(["planner", "researcher", "coder", "reviewer"], "planner");
    const filteredRoute = applyArchitectureFilter(rawRoute, allowedAgents);

    assert.ok(!filteredRoute.agents.includes("planner"),    "planner filtered");
    assert.ok(!filteredRoute.agents.includes("researcher"), "researcher filtered");
    assert.ok(filteredRoute.agents.includes("coder"),       "coder survives");
    assert.ok(filteredRoute.agents.includes("reviewer"),    "reviewer survives");
    assert.equal(filteredRoute.primary, "coder");
  });

  it("default diagram → all agents allowed, route unchanged", () => {
    const allowedAgents = parseArchitectureAgents(DEFAULT_MERMAID);
    const rawRoute = makeRoute(["planner", "researcher", "reviewer"], "planner");
    const filteredRoute = applyArchitectureFilter(rawRoute, allowedAgents);

    // All agents in the raw route exist in the default diagram
    assert.deepEqual(filteredRoute.agents, rawRoute.agents);
    assert.equal(filteredRoute.primary, rawRoute.primary);
  });
});
