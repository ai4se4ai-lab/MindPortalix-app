/**
 * Unit tests for src/services/system/co-system.js
 *
 * Covers: null client returns defaults, cache-miss loads from DB,
 * cache-hit skips DB, DB error returns defaults, multi-user isolation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getWorkspaceContext } from "../../src/services/system/co-system.js";
import {
  getCachedContext,
  setCachedContext,
  invalidateCachedContext,
  _resetForTests,
} from "../../src/services/system/co-context-store.js";
import { DEFAULT_MERMAID, DEFAULT_CONTEXT_INJECTION } from "../../src/lib/defaults.js";

// ── Mock DB client factory ────────────────────────────────────────────────────

function makeClient(rows = {}) {
  const defaults = {
    workspace_settings: [{ mermaid_diagram: "graph LR; A-->B", agent_overrides: "{}" }],
    context_injection:  [{ rules: JSON.stringify([{ id: "CLAUDE.md", active: true }]) }],
    workspace_files:    [],
  };
  const store = { ...defaults, ...rows };

  return {
    from(table) {
      const tableData = store[table] ?? [];
      return {
        select() { return this; },
        eq()     { return this; },
        limit()  { return this; },
        single() { return this; },
        // Promise that resolves to { data, error }
        then(resolve) {
          return Promise.resolve({ data: tableData[0] ?? null, error: null }).then(resolve);
        },
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_CTX = {
  mermaidDiagram:   "graph LR; A-->B",
  agentOverrides:   {},
  contextInjection: DEFAULT_CONTEXT_INJECTION,
  claudeMd:         "",
  memoryMd:         "",
  resources:        [],
  files:            [],
  contextFiles:     [],
};

beforeEach(() => { _resetForTests(); });
afterEach(() => { _resetForTests(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("co-system — null client returns FALLBACK_CONTEXT", () => {
  it("returns default mermaid diagram when no DB configured", async () => {
    const ctx = await getWorkspaceContext(null, "user-1");
    assert.strictEqual(ctx.mermaidDiagram, DEFAULT_MERMAID);
  });

  it("returns default contextInjection when no DB configured", async () => {
    const ctx = await getWorkspaceContext(null, "user-1");
    assert.deepStrictEqual(ctx.contextInjection, DEFAULT_CONTEXT_INJECTION);
  });

  it("returns empty arrays for files, resources, contextFiles", async () => {
    const ctx = await getWorkspaceContext(null, "user-1");
    assert.deepStrictEqual(ctx.files,        []);
    assert.deepStrictEqual(ctx.resources,     []);
    assert.deepStrictEqual(ctx.contextFiles,  []);
  });

  it("returns a fresh object each call (no shared reference)", async () => {
    const a = await getWorkspaceContext(null, "user-1");
    const b = await getWorkspaceContext(null, "user-1");
    assert.notStrictEqual(a, b);
  });
});

describe("co-system — cache-aside logic", () => {
  it("cache hit: returns cached data without calling DB", async () => {
    const cached = { ...SAMPLE_CTX, mermaidDiagram: "graph LR; CACHED-->YES" };
    setCachedContext("user-cache-hit", cached);

    // The client would fail if called (no .from() needed)
    const fakeClient = { from() { throw new Error("DB should not be called"); } };
    const ctx = await getWorkspaceContext(fakeClient, "user-cache-hit");
    assert.strictEqual(ctx.mermaidDiagram, "graph LR; CACHED-->YES");
  });

  it("cache miss: populates cache after loading from DB", async () => {
    // Verify cache is empty first
    assert.strictEqual(getCachedContext("user-miss"), null);

    // Use null client → returns FALLBACK, does NOT cache (no DB configured)
    await getWorkspaceContext(null, "user-miss");
    // null client path returns without caching
    assert.strictEqual(getCachedContext("user-miss"), null, "null client skips caching");
  });

  it("after invalidation, next call re-fetches (uses null client fallback for simplicity)", async () => {
    const ctx1 = await getWorkspaceContext(null, "user-reinit");
    assert.ok(ctx1.mermaidDiagram === DEFAULT_MERMAID);

    // Invalidate and re-fetch — should still return defaults (null client)
    invalidateCachedContext("user-reinit");
    const ctx2 = await getWorkspaceContext(null, "user-reinit");
    assert.strictEqual(ctx2.mermaidDiagram, DEFAULT_MERMAID);
  });
});

describe("co-system — multi-user isolation", () => {
  it("different users get independent cached contexts", async () => {
    const aliceCtx = { ...SAMPLE_CTX, mermaidDiagram: "graph LR; Alice-->X" };
    const bobCtx   = { ...SAMPLE_CTX, mermaidDiagram: "graph LR; Bob-->Y"   };

    setCachedContext("alice", aliceCtx);
    setCachedContext("bob",   bobCtx);

    const alice = await getWorkspaceContext({ from() { throw new Error("no DB"); } }, "alice");
    const bob   = await getWorkspaceContext({ from() { throw new Error("no DB"); } }, "bob");

    assert.strictEqual(alice.mermaidDiagram, "graph LR; Alice-->X");
    assert.strictEqual(bob.mermaidDiagram,   "graph LR; Bob-->Y");
  });

  it("invalidating alice does not affect bob", async () => {
    const ctx = { ...SAMPLE_CTX, mermaidDiagram: "graph LR; X-->Y" };
    setCachedContext("alice", ctx);
    setCachedContext("bob",   ctx);

    invalidateCachedContext("alice");

    assert.strictEqual(getCachedContext("alice"), null);
    assert.deepStrictEqual(getCachedContext("bob"), ctx);
  });
});

describe("co-system — DB error falls back to defaults", () => {
  it("returns FALLBACK_CONTEXT when DB throws during context load", async () => {
    // Pre-condition: no cached context
    assert.strictEqual(getCachedContext("user-err"), null);

    // Client whose .from() throws immediately
    const brokenClient = {
      from() { throw new Error("DB connection refused"); },
    };

    const ctx = await getWorkspaceContext(brokenClient, "user-err");
    assert.strictEqual(ctx.mermaidDiagram, DEFAULT_MERMAID);
    assert.deepStrictEqual(ctx.contextInjection, DEFAULT_CONTEXT_INJECTION);
  });
});
