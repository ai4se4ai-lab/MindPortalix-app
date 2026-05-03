/**
 * Unit tests for src/services/user/ws-service.js
 *
 * Covers: every write operation invalidates CO cache directly,
 * every write broadcasts ws_write, reads do not invalidate cache.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as wsService from "../../src/services/user/ws-service.js";
import {
  getCachedContext,
  setCachedContext,
  cacheSize,
  _resetForTests,
} from "../../src/services/system/co-context-store.js";
import { subscribe } from "../../src/monitor/broadcaster.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_CTX = {
  mermaidDiagram:   "graph LR; A-->B",
  agentOverrides:   {},
  contextInjection: [],
  claudeMd:         "",
  memoryMd:         "",
  resources:        [],
  files:            [],
  contextFiles:     [],
};

/** Collect all ws_write broadcasts during `fn()`, returns array of { event, data } */
async function captureWsWriteEvents(fn) {
  const events = [];
  const unsub = subscribe(({ event, data }) => {
    if (event === "ws_write") events.push({ event, data });
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return events;
}

/** Build an in-memory mock client whose DB calls resolve successfully */
function makeClient(overrides = {}) {
  const base = {
    from() {
      return {
        select() { return this; },
        eq()     { return this; },
        insert() { return this; },
        upsert() { return this; },
        update() { return this; },
        delete() { return this; },
        single() { return this; },
        limit()  { return this; },
        in()     { return this; },
        not()    { return this; },
        like()   { return this; },
        order()  { return this; },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      };
    },
    ...overrides,
  };
  return base;
}

beforeEach(() => { _resetForTests(); });
afterEach(() => { _resetForTests(); });

// ── Write operations: CO cache invalidation ───────────────────────────────────

describe("ws-service — writes invalidate CO cache directly", () => {
  it("initWorkspace invalidates CO cache for that user", async () => {
    const userId = "user-init";
    setCachedContext(userId, SAMPLE_CTX);
    assert.ok(getCachedContext(userId) !== null, "pre-condition: cache populated");

    await wsService.initWorkspace(makeClient(), userId);

    assert.strictEqual(getCachedContext(userId), null, "cache cleared after initWorkspace");
  });

  it("upsertAgentConfig invalidates CO cache for that user", async () => {
    const userId = "user-agent";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.upsertAgentConfig(makeClient(), userId, { mermaid_diagram: "graph LR; X-->Y" });

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("upsertContextInjection invalidates CO cache for that user", async () => {
    const userId = "user-ci";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.upsertContextInjection(makeClient(), userId, []);

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("upsertFile invalidates CO cache for that user", async () => {
    const userId = "user-file";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.upsertFile(makeClient(), userId, "notes.md", { content: "hello" });

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("deleteFile invalidates CO cache for that user", async () => {
    const userId = "user-del";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.deleteFile(makeClient(), userId, "notes.md");

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("uploadFile invalidates CO cache for that user", async () => {
    const userId = "user-upload";
    setCachedContext(userId, SAMPLE_CTX);

    // uploadFile returns path from dbUploadFile — mock returns null (truthy check skipped)
    await wsService.uploadFile(makeClient(), userId, { name: "file.txt", content: "data", mime_type: "text/plain" });

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("createDirectory invalidates CO cache for that user", async () => {
    const userId = "user-dir";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.createDirectory(makeClient(), userId, "MyWorkstation");

    assert.strictEqual(getCachedContext(userId), null);
  });

  it("write for user-A does not clear cache for user-B", async () => {
    setCachedContext("user-a", SAMPLE_CTX);
    setCachedContext("user-b", SAMPLE_CTX);

    await wsService.upsertAgentConfig(makeClient(), "user-a", {});

    assert.strictEqual(getCachedContext("user-a"), null,        "user-a cleared");
    assert.deepStrictEqual(getCachedContext("user-b"), SAMPLE_CTX, "user-b unaffected");
  });
});

// ── Write operations: ws_write broadcast ─────────────────────────────────────

describe("ws-service — writes broadcast ws_write event", () => {
  it("initWorkspace broadcasts ws_write with userId", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.initWorkspace(makeClient(), "u1")
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u1");
  });

  it("upsertAgentConfig broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.upsertAgentConfig(makeClient(), "u2", {})
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u2");
  });

  it("upsertContextInjection broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.upsertContextInjection(makeClient(), "u3", [])
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u3");
  });

  it("upsertFile broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.upsertFile(makeClient(), "u4", "path.md", {})
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u4");
  });

  it("deleteFile broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.deleteFile(makeClient(), "u5", "path.md")
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u5");
  });

  it("uploadFile broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.uploadFile(makeClient(), "u6", { name: "x.txt", content: "y", mime_type: "text/plain" })
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u6");
  });

  it("createDirectory broadcasts ws_write", async () => {
    const events = await captureWsWriteEvents(() =>
      wsService.createDirectory(makeClient(), "u7", "Dir")
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.userId, "u7");
  });
});

// ── Read operations: no CO invalidation ──────────────────────────────────────

describe("ws-service — reads do NOT invalidate CO cache", () => {
  it("getAgentConfig does not clear CO cache", async () => {
    const userId = "user-read-agent";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.getAgentConfig(makeClient(), userId);

    assert.deepStrictEqual(getCachedContext(userId), SAMPLE_CTX, "cache intact after read");
  });

  it("getContextInjection does not clear CO cache", async () => {
    const userId = "user-read-ci";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.getContextInjection(makeClient(), userId);

    assert.deepStrictEqual(getCachedContext(userId), SAMPLE_CTX);
  });

  it("getFiles does not clear CO cache", async () => {
    const userId = "user-read-files";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.getFiles(makeClient(), userId);

    assert.deepStrictEqual(getCachedContext(userId), SAMPLE_CTX);
  });

  it("getFile does not clear CO cache", async () => {
    const userId = "user-read-file";
    setCachedContext(userId, SAMPLE_CTX);

    await wsService.getFile(makeClient(), userId, "notes.md");

    assert.deepStrictEqual(getCachedContext(userId), SAMPLE_CTX);
  });

  it("reads do not broadcast ws_write", async () => {
    const events = await captureWsWriteEvents(async () => {
      await wsService.getAgentConfig(makeClient(), "user-nobroadcast");
      await wsService.getFiles(makeClient(), "user-nobroadcast");
    });
    assert.strictEqual(events.length, 0, "no ws_write events from reads");
  });
});
