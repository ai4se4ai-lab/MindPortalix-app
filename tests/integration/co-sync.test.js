/**
 * Integration tests: WS writes → CO cache sync
 *
 * Covers:
 *   1. Write then read returns fresh data (no stale cache)
 *   2. Multi-user isolation: Alice's write does not contaminate Bob's context
 *   3. Cache is warm on second read (same data returned)
 *   4. Sequential writes accumulate correctly
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import workspaceRouter, {
  _setSupabaseFactory,
  _resetSupabaseFactory,
} from "../../src/server/routes/workspace.js";

import {
  getCachedContext,
  cacheSize,
  _resetForTests,
} from "../../src/services/system/co-context-store.js";

// ── In-memory Supabase ────────────────────────────────────────────────────────

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

function buildApp(userId, store) {
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

// ── Suite setup ───────────────────────────────────────────────────────────────

beforeEach(() => { _resetForTests(); });
afterEach(() => { _resetForTests(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CO sync — write then read returns fresh data", () => {
  let srv, port, store;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    const app = buildApp("user-sync-1", store);
    srv  = await startServer(app);
    port = srv.address().port;
  });

  after(() => new Promise(r => srv.close(r)));
  afterEach(() => { _resetForTests(); _setSupabaseFactory(() => makeClient(store)); });

  it("agent-config update is reflected in /context immediately", async () => {
    const newDiagram = "graph LR; Orchestrator-->Planner";
    await req(port, "PUT", "/agent-config", { mermaid_diagram: newDiagram, agent_overrides: {} });

    const r = await req(port, "GET", "/context");
    assert.ok(r.ok, "GET /context should succeed");
    assert.strictEqual(r.data.mermaidDiagram, newDiagram,
      "mermaid diagram must reflect the just-written value, not a stale cache");
  });

  it("context-injection update is reflected in /context immediately", async () => {
    const newRules = [{ id: "MEMORY.md", active: false }];
    await req(port, "PUT", "/context-injection", { rules: newRules });

    const r = await req(port, "GET", "/context");
    assert.ok(r.ok);
    assert.deepStrictEqual(r.data.contextInjection, newRules,
      "context injection must reflect updated rules");
  });

  it("file upload is visible in /context files after upload", async () => {
    const uploadBody = { name: "report.md", content: "# Report", mime_type: "text/markdown" };
    const uploadR = await req(port, "POST", "/upload", uploadBody);
    assert.ok(uploadR.ok, "upload should succeed");

    const r = await req(port, "GET", "/context");
    assert.ok(r.ok);
    const paths = r.data.files.map(f => f.path ?? f.file_path ?? f.name ?? JSON.stringify(f));
    assert.ok(
      paths.some(p => p.includes("report")),
      `uploaded file should appear in /context files. Got: ${JSON.stringify(r.data.files)}`
    );
  });

  it("second GET /context returns same data (cache warm)", async () => {
    const r1 = await req(port, "GET", "/context");
    const r2 = await req(port, "GET", "/context");
    assert.ok(r1.ok && r2.ok);
    assert.deepStrictEqual(r1.data, r2.data, "repeated reads return identical data");
  });
});

describe("CO sync — multi-user isolation", () => {
  let aliceSrv, bobSrv, alicePort, bobPort;
  let aliceStore, bobStore;

  before(async () => {
    aliceStore = new InMemoryStore();
    bobStore   = new InMemoryStore();

    // Use separate servers, each with their own userId + store
    // We need a factory that returns the right client per request.
    // Since test hook is global, we use two separate test runs with a shared factory
    // that dispatches by userId — but the factory only receives the token.
    // Simplest approach: two separate server setups with independent factory calls.

    _setSupabaseFactory(() => makeClient(aliceStore));
    const aliceApp = buildApp("alice-sync", aliceStore);
    aliceSrv  = await startServer(aliceApp);
    alicePort = aliceSrv.address().port;

    _setSupabaseFactory(() => makeClient(bobStore));
    const bobApp = buildApp("bob-sync", bobStore);
    bobSrv  = await startServer(bobApp);
    bobPort = bobSrv.address().port;
  });

  after(() => Promise.all([
    new Promise(r => aliceSrv.close(r)),
    new Promise(r => bobSrv.close(r)),
  ]));

  afterEach(() => { _resetForTests(); });

  it("Alice's diagram update does not appear in Bob's /context", async () => {
    _setSupabaseFactory(() => makeClient(aliceStore));
    const aliceDiagram = "graph LR; Alice-->UniqueAgent";
    await req(alicePort, "PUT", "/agent-config", { mermaid_diagram: aliceDiagram, agent_overrides: {} });

    _setSupabaseFactory(() => makeClient(bobStore));
    const bobR = await req(bobPort, "GET", "/context");
    assert.ok(bobR.ok);
    assert.notStrictEqual(
      bobR.data.mermaidDiagram, aliceDiagram,
      "Bob should not see Alice's diagram"
    );
  });

  it("Bob's diagram update does not appear in Alice's /context", async () => {
    _setSupabaseFactory(() => makeClient(bobStore));
    const bobDiagram = "graph LR; Bob-->UniqueAgent";
    await req(bobPort, "PUT", "/agent-config", { mermaid_diagram: bobDiagram, agent_overrides: {} });

    _setSupabaseFactory(() => makeClient(aliceStore));
    const aliceR = await req(alicePort, "GET", "/context");
    assert.ok(aliceR.ok);
    assert.notStrictEqual(
      aliceR.data.mermaidDiagram, bobDiagram,
      "Alice should not see Bob's diagram"
    );
  });
});

describe("CO sync — sequential writes accumulate correctly", () => {
  let srv, port, store;

  before(async () => {
    store = new InMemoryStore();
    _setSupabaseFactory(() => makeClient(store));
    const app = buildApp("user-seq", store);
    srv  = await startServer(app);
    port = srv.address().port;
  });

  after(() => new Promise(r => srv.close(r)));
  afterEach(() => { _resetForTests(); _setSupabaseFactory(() => makeClient(store)); });

  it("last write wins for agent-config diagram", async () => {
    await req(port, "PUT", "/agent-config", { mermaid_diagram: "graph LR; First-->A", agent_overrides: {} });
    await req(port, "PUT", "/agent-config", { mermaid_diagram: "graph LR; Second-->B", agent_overrides: {} });
    await req(port, "PUT", "/agent-config", { mermaid_diagram: "graph LR; Third-->C",  agent_overrides: {} });

    const r = await req(port, "GET", "/context");
    assert.ok(r.ok);
    assert.strictEqual(r.data.mermaidDiagram, "graph LR; Third-->C",
      "/context should reflect the last write");
  });

  it("multiple file uploads are all visible in /context", async () => {
    await req(port, "POST", "/upload", { name: "file-a.md", content: "# A", mime_type: "text/markdown" });
    await req(port, "POST", "/upload", { name: "file-b.md", content: "# B", mime_type: "text/markdown" });

    const r = await req(port, "GET", "/context");
    assert.ok(r.ok);
    const paths = r.data.files.map(f => f.path ?? f.file_path ?? f.name ?? JSON.stringify(f));
    assert.ok(paths.some(p => p.includes("file-a")), "file-a should be in /context");
    assert.ok(paths.some(p => p.includes("file-b")), "file-b should be in /context");
  });
});
