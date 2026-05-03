/**
 * WS User-Level Services — all user-facing workspace mutation operations.
 *
 * Every write calls notifyWrite(userId) which broadcasts "ws_write" on the
 * monitor bus. The CO context store subscribes to this event and drops the
 * user's CO cache entry immediately, ensuring WS and CO are always in sync
 * (Principle 1).
 */
import { broadcast } from "../../monitor/broadcaster.js";
import { invalidateCachedContext } from "../system/co-context-store.js";
import * as ws from "../system/ws-system.js";

function notifyWrite(userId) {
  invalidateCachedContext(userId); // Direct invalidation — works even without initCoContextStore()
  broadcast("ws_write", { userId });
}

// ── Mutating operations (always trigger CO invalidation) ──────────────────────

export async function initWorkspace(client, userId) {
  await ws.dbInitWorkspace(client, userId);
  notifyWrite(userId);
}

export async function upsertAgentConfig(client, userId, payload) {
  await ws.dbUpsertAgentConfig(client, userId, payload);
  notifyWrite(userId);
}

export async function upsertContextInjection(client, userId, rules) {
  await ws.dbUpsertContextInjection(client, userId, rules);
  notifyWrite(userId);
}

export async function upsertFile(client, userId, filePath, body) {
  await ws.dbUpsertFile(client, userId, filePath, body);
  notifyWrite(userId);
}

export async function deleteFile(client, userId, filePath) {
  await ws.dbDeleteFile(client, userId, filePath);
  notifyWrite(userId);
}

export async function uploadFile(client, userId, payload) {
  const path = await ws.dbUploadFile(client, userId, payload);
  notifyWrite(userId);
  return path;
}

export async function createDirectory(client, userId, safeName) {
  const path = await ws.dbCreateDirectory(client, userId, safeName);
  notifyWrite(userId);
  return path;
}

// ── Read-only operations (no CO invalidation needed) ─────────────────────────

export const getAgentConfig       = ws.dbGetAgentConfig;
export const getContextInjection  = ws.dbGetContextInjection;
export const getFiles             = ws.dbGetFiles;
export const getFile              = ws.dbGetFile;
