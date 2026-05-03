import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { AGENT_REGISTRY } from "../agents/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// Lowercase Mermaid node aliases → canonical agent IDs in the registry
const MERMAID_ALIASES = {
  imagegen: "image_generator",
  audiogen: "audio_generator",
};

// Tokens that appear in Mermaid diagrams but are not agent names
const NON_AGENT_TOKENS = new Set([
  "userinput", "response", "user", "input", "output",
  "td", "lr", "bt", "rl", "flowchart", "graph", "subgraph", "end",
  "click", "style", "classDef", "class",
]);

/**
 * Parse which agent IDs are present in a Mermaid diagram string.
 * Returns a Set<string> of canonical agent IDs from the registry,
 * or null if the diagram is blank/unparseable (meaning: no restriction, use default routing).
 */
export function parseArchitectureAgents(mermaidStr) {
  if (!mermaidStr?.trim()) return null;

  const registryIds = new Set(Object.keys(AGENT_REGISTRY));
  const found = new Set();

  // Match identifiers: start of word, alphanumeric + underscore
  const tokenPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = tokenPattern.exec(mermaidStr)) !== null) {
    const token = m[1].toLowerCase();
    if (NON_AGENT_TOKENS.has(token)) continue;
    const resolved = MERMAID_ALIASES[token] ?? token;
    if (registryIds.has(resolved)) found.add(resolved);
  }

  return found.size > 0 ? found : null;
}

/**
 * Filter a route returned by classifyIntent() so only agents present
 * in the user's architecture diagram can participate.
 *
 * - allowedAgents === null  → no restriction, return route unchanged
 * - reviewer is always kept if it was in the original route (quality gate)
 * - if no specialists survive filtering, falls back to the best available agent
 */
export function applyArchitectureFilter(route, allowedAgents) {
  if (!allowedAgents) return route;

  const filtered = route.agents.filter(id =>
    allowedAgents.has(id) || id === "reviewer"
  );

  const filteredSpecialists = filtered.filter(id => id !== "reviewer");

  if (filteredSpecialists.length === 0) {
    // Nothing survived — pick best available from the allowed set
    const preferredOrder = ["executor", "writer", "researcher", "coder", "planner", "memory"];
    const fallback =
      preferredOrder.find(id => allowedAgents.has(id)) ??
      [...allowedAgents].find(id => id !== "reviewer") ??
      "writer";
    const fallbackRoute = [fallback];
    if (filtered.includes("reviewer")) fallbackRoute.push("reviewer");
    return { ...route, agents: fallbackRoute, primary: fallback };
  }

  const primary = allowedAgents.has(route.primary)
    ? route.primary
    : filteredSpecialists[0];

  return { ...route, agents: filtered, primary };
}

/**
 * Load content of enabled context-injection items.
 * For each enabled category + item, checks personal copies first
 * (from workspaceFiles, which includes _context/ rows from the DB),
 * then falls back to the server-side file at {category}/{item}.md.
 *
 * Returns a formatted context string, or "" if nothing was loaded.
 */
/**
 * @returns {{ content: string, details: Array<{category,label,item,excerpt,source}> }}
 *   content  — combined context string for the agent system prompt
 *   details  — structured list of which files were loaded (for the Context Observatory feed)
 */
export async function buildContextInjectionContent(contextInjection, workspaceFiles = []) {
  const sections = [];
  const details = [];

  for (const rule of (contextInjection ?? [])) {
    if (!rule.active) continue;
    const itemContents = [];

    for (const item of (rule.items ?? [])) {
      const personalPath = `_context/${rule.id}/${item}`;
      const personal = workspaceFiles.find(f => f.path === personalPath);
      let rawContent = null;
      let source = "disk";

      if (personal?.content?.trim()) {
        rawContent = personal.content.trim();
        source = "personal";
      } else {
        try {
          rawContent = (await readFile(join(ROOT, rule.id, `${item}.md`), "utf8")).trim();
        } catch {
          // File absent — skip silently
        }
      }

      if (rawContent) {
        itemContents.push(`### ${item}\n${rawContent}`);
        details.push({ category: rule.id, label: rule.label, item, excerpt: rawContent.slice(0, 300), source });
      }
    }

    if (itemContents.length > 0) {
      sections.push(`## ${rule.label}\n${itemContents.join("\n\n")}`);
    }
  }

  return {
    content: sections.length > 0
      ? `# Workspace Context Configuration\n\n${sections.join("\n\n")}`
      : "",
    details,
  };
}
