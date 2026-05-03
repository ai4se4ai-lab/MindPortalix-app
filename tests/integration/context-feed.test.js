/**
 * Context Feed tests
 *
 * Covers:
 *   1. buildContextInjectionContent — details array for disk, personal, and missing files
 *   2. broadcaster — subscribe/publish roundtrip for context_feed and context_turn_end
 *   3. context_feed payload shape for different query types
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContextInjectionContent } from "../../src/orchestration/architecture.js";
import { broadcast, subscribe } from "../../src/monitor/broadcaster.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Helper: wrap an event-based assertion in a Promise ────────────────────────

function waitForEvent(eventName, predicate, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const unsub = subscribe(({ event, data, ts }) => {
      if (event !== eventName) return;
      if (predicate && !predicate(data)) return;
      clearTimeout(timer);
      unsub();
      resolve({ data, ts });
    });
  });
}

// ── 1. buildContextInjectionContent ──────────────────────────────────────────

describe("buildContextInjectionContent — details array", () => {
  it("returns empty content and details when no rules are active", async () => {
    const rules = [{ id: "skills", label: "Skills", active: false, items: ["coding"] }];
    const { content, details } = await buildContextInjectionContent(rules, []);
    assert.equal(content, "");
    assert.deepEqual(details, []);
  });

  it("returns empty content and details for null/undefined input", async () => {
    const { content, details } = await buildContextInjectionContent(null, []);
    assert.equal(content, "");
    assert.deepEqual(details, []);
  });

  it("returns details with source=disk when disk file exists", async () => {
    const ruleId = "_test_ctx_disk_" + Date.now();
    const targetDir = join(PROJECT_ROOT, ruleId);
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "test_item.md"), "# Test skill\nDo the thing.", "utf8");

    try {
      const rules = [{ id: ruleId, label: "Test Skills", active: true, items: ["test_item"] }];
      const { content, details } = await buildContextInjectionContent(rules, []);

      assert.ok(content.includes("# Workspace Context Configuration"), "content has header");
      assert.ok(content.includes("Test Skills"), "content has label");
      assert.ok(content.includes("test_item"), "content has item");

      assert.equal(details.length, 1);
      assert.equal(details[0].category, ruleId);
      assert.equal(details[0].label, "Test Skills");
      assert.equal(details[0].item, "test_item");
      assert.equal(details[0].source, "disk");
      assert.ok(details[0].excerpt.includes("Test skill"), "excerpt has content");
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("prefers personal content (source=personal) over disk file", async () => {
    const rules = [{ id: "skills", label: "Skills", active: true, items: ["coding"] }];
    const personalOverride = [
      { path: "_context/skills/coding", content: "Personal coding instructions here." }
    ];
    const { content, details } = await buildContextInjectionContent(rules, personalOverride);

    assert.ok(content.includes("Personal coding instructions"), "personal content injected");
    assert.equal(details.length, 1);
    assert.equal(details[0].source, "personal");
    assert.ok(details[0].excerpt.includes("Personal coding"), "excerpt matches personal content");
  });

  it("skips items with no disk file and no personal override (silent)", async () => {
    const rules = [
      { id: "skills", label: "Skills", active: true, items: ["nonexistent_item_xyz_abc"] }
    ];
    const { content, details } = await buildContextInjectionContent(rules, []);
    assert.equal(content, "");
    assert.equal(details.length, 0);
  });

  it("handles multiple rules and multiple items, building details per item", async () => {
    const rules = [
      { id: "skills", label: "Skills", active: true, items: ["coding"] },
      { id: "skills", label: "Skills", active: true, items: ["writing"] },
    ];
    const workspaceFiles = [
      { path: "_context/skills/coding",  content: "Coding rule A." },
      { path: "_context/skills/writing", content: "Writing rule B." },
    ];
    const { details } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.equal(details.length, 2);
    const items = details.map(d => d.item).sort();
    assert.deepEqual(items, ["coding", "writing"]);
    assert.ok(details.every(d => d.source === "personal"));
  });

  it("excerpt is capped at 300 characters", async () => {
    const longContent = "x".repeat(500);
    const rules = [{ id: "skills", label: "Skills", active: true, items: ["long_item"] }];
    const workspaceFiles = [{ path: "_context/skills/long_item", content: longContent }];
    const { details } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.equal(details.length, 1);
    assert.ok(details[0].excerpt.length <= 300, "excerpt capped at 300 chars");
  });

  it("inactive rule with active sibling only returns details for active rule", async () => {
    const rules = [
      { id: "skills", label: "Skills", active: false, items: ["coding"] },
      { id: "skills", label: "Skills", active: true,  items: ["writing"] },
    ];
    const workspaceFiles = [
      { path: "_context/skills/coding",  content: "Coding content." },
      { path: "_context/skills/writing", content: "Writing content." },
    ];
    const { details } = await buildContextInjectionContent(rules, workspaceFiles);
    assert.equal(details.length, 1);
    assert.equal(details[0].item, "writing");
  });
});

// ── 2. Broadcaster — subscribe/publish roundtrip ──────────────────────────────

describe("broadcaster — context_feed and context_turn_end events", () => {
  it("subscriber receives context_feed event with all fields", async () => {
    const tag = "feed-all-fields-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag,
      agents: ["memory", "executor"],
      memories: [{ topic: "user", summary: "User is named Majid." }],
      claudeMd: "# Instructions\nBe helpful.",
      memoryMd: "# Memory\n## About Me\n- Name: Majid",
      resources: [{ name: "notes.txt", excerpt: "Project notes here." }],
      skillFiles: [{ category: "skills", label: "Skills", item: "coding", excerpt: "Code well.", source: "disk" }],
    });

    const { data } = await promise;
    assert.equal(data.query, tag);
    assert.deepEqual(data.agents, ["memory", "executor"]);
    assert.equal(data.memories.length, 1);
    assert.equal(data.memories[0].topic, "user");
    assert.ok(data.claudeMd.includes("Instructions"));
    assert.ok(data.memoryMd.includes("Majid"));
    assert.equal(data.resources.length, 1);
    assert.equal(data.skillFiles.length, 1);
    assert.equal(data.skillFiles[0].source, "disk");
  });

  it("subscriber receives context_turn_end event with query", async () => {
    const tag = "turn-end-" + Date.now();
    const promise = waitForEvent("context_turn_end", d => d.query === tag);
    broadcast("context_turn_end", { query: tag });
    const { data } = await promise;
    assert.equal(data.query, tag);
  });

  it("context_feed event has a timestamp set by broadcaster", async () => {
    const tag = "ts-check-" + Date.now();
    const before = Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);
    broadcast("context_feed", { query: tag, agents: [] });
    const { ts } = await promise;
    assert.ok(ts >= before, "timestamp is at or after broadcast time");
    assert.ok(ts <= Date.now() + 50, "timestamp is not far in the future");
  });

  it("multiple sequential context_feed events are all received in order", async () => {
    const base = "seq-" + Date.now() + "-";
    const queries = [base + "first", base + "second", base + "third"];
    const received = [];

    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out")), 1000);
      const unsub = subscribe(({ event, data }) => {
        if (event !== "context_feed") return;
        if (!data.query?.startsWith(base)) return;
        received.push(data.query);
        if (received.length === queries.length) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    for (const q of queries) {
      broadcast("context_feed", { query: q, agents: [] });
    }

    await done;
    assert.deepEqual(received, queries);
  });

  it("context_feed followed by context_turn_end simulates a full turn", async () => {
    const tag = "full-turn-" + Date.now();
    const events = [];

    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out")), 1000);
      const unsub = subscribe(({ event, data }) => {
        if (data.query !== tag) return;
        events.push(event);
        if (events.length === 2) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    broadcast("context_feed",    { query: tag, agents: ["writer"] });
    broadcast("context_turn_end", { query: tag });

    await done;
    assert.equal(events[0], "context_feed");
    assert.equal(events[1], "context_turn_end");
  });
});

// ── 3. context_feed payload shape for different query types ──────────────────

describe("context_feed payload — different query and skill scenarios", () => {
  it("empty memory and skill fields produce minimal context_feed payload", async () => {
    const tag = "minimal-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag, agents: [], memories: [],
      claudeMd: null, memoryMd: null, resources: [], skillFiles: [],
    });

    const { data } = await promise;
    assert.deepEqual(data.agents, []);
    assert.deepEqual(data.memories, []);
    assert.equal(data.claudeMd, null);
    assert.equal(data.memoryMd, null);
    assert.deepEqual(data.resources, []);
    assert.deepEqual(data.skillFiles, []);
  });

  it("memory-heavy query surfaces memory snippets and MEMORY.md", async () => {
    const tag = "memory-heavy-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag,
      agents: ["memory", "executor"],
      memories: [
        { topic: "name",    summary: "User's name is Majid." },
        { topic: "project", summary: "Working on MindPortalix." },
      ],
      claudeMd: null,
      memoryMd: "# Memory\n## About Me\n- Name: Majid",
      resources: [], skillFiles: [],
    });

    const { data } = await promise;
    assert.ok(data.memoryMd.includes("Majid"), "memoryMd has name");
    assert.equal(data.memories.length, 2);
    assert.ok(data.memories.some(m => m.topic === "name"), "memories include name topic");
  });

  it("skill-rich query shows multiple skill file details", async () => {
    const tag = "skill-rich-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag,
      agents: ["researcher", "coder", "planner"],
      memories: [], claudeMd: "# Instructions", memoryMd: null, resources: [],
      skillFiles: [
        { category: "skills", label: "Skills", item: "coding",   excerpt: "Write clean code.",  source: "disk" },
        { category: "skills", label: "Skills", item: "research", excerpt: "Cite your sources.",  source: "disk" },
        { category: "skills", label: "Skills", item: "planning", excerpt: "Break down tasks.",   source: "disk" },
      ],
    });

    const { data } = await promise;
    assert.equal(data.skillFiles.length, 3);
    const items = data.skillFiles.map(f => f.item).sort();
    assert.deepEqual(items, ["coding", "planning", "research"]);
    assert.ok(data.skillFiles.every(f => f.source === "disk"));
  });

  it("resource-bearing query exposes resource excerpts", async () => {
    const tag = "resource-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag,
      agents: ["writer"],
      memories: [], claudeMd: null, memoryMd: null,
      resources: [
        { name: "spec.md",  excerpt: "Product specification text." },
        { name: "notes.py", excerpt: "# helper script\nprint('hello')" },
      ],
      skillFiles: [],
    });

    const { data } = await promise;
    assert.equal(data.resources.length, 2);
    assert.ok(data.resources.some(r => r.name === "spec.md"));
    assert.ok(data.resources.some(r => r.name === "notes.py"));
  });

  it("personal skill override is identified by source=personal in details", async () => {
    const tag = "personal-skill-" + Date.now();
    const promise = waitForEvent("context_feed", d => d.query === tag);

    broadcast("context_feed", {
      query: tag,
      agents: ["executor"],
      memories: [], claudeMd: null, memoryMd: null, resources: [],
      skillFiles: [
        { category: "skills", label: "Skills", item: "writing", excerpt: "Custom writing style.", source: "personal" },
      ],
    });

    const { data } = await promise;
    const personalSkill = data.skillFiles.find(f => f.source === "personal");
    assert.ok(personalSkill, "personal skill file present");
    assert.ok(personalSkill.excerpt.includes("Custom"), "personal excerpt has custom content");
  });
});
