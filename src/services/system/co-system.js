/**
 * CO System Services — assembles workspace context for chat agents.
 *
 * Principle 2: Chat agents read from CO, never from WS directly.
 * This module is the single entry point for all context reads during chat.
 * Cache-aside: check CO cache first, load from WS DB on miss, populate cache.
 */
import { getCachedContext, setCachedContext } from "./co-context-store.js";
import { dbGetWorkspaceContext } from "./ws-system.js";
import { DEFAULT_MERMAID, DEFAULT_CONTEXT_INJECTION } from "../../lib/defaults.js";

const FALLBACK_CONTEXT = {
  mermaidDiagram:   DEFAULT_MERMAID,
  agentOverrides:   {},
  contextInjection: DEFAULT_CONTEXT_INJECTION,
  claudeMd:         "",
  memoryMd:         "",
  resources:        [],
  files:            [],
  contextFiles:     [],
};

/**
 * Get workspace context for a user.
 * Uses CO cache; loads from DB on miss; returns defaults when no DB configured.
 *
 * @param {object|null} client - Supabase client, or null when DB not configured
 * @param {string} userId
 * @returns {Promise<object>} workspace context object
 */
export async function getWorkspaceContext(client, userId) {
  if (!client) return { ...FALLBACK_CONTEXT };

  const cached = getCachedContext(userId);
  if (cached) return cached;

  // Cache miss — load from WS database and populate CO
  try {
    const data = await dbGetWorkspaceContext(client, userId);
    setCachedContext(userId, data);
    return data;
  } catch {
    return { ...FALLBACK_CONTEXT };
  }
}
