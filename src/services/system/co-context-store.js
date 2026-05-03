/**
 * CO Context Store — per-user in-process cache of assembled workspace context.
 *
 * Principle 1: WS and CO must always be in sync.
 * Any WS mutation broadcasts "ws_write". The listener here immediately drops
 * that user's cache entry so the next CO read re-fetches from the DB.
 *
 * Call initCoContextStore() once at server startup to wire up the listener.
 */
import { subscribe } from "../../monitor/broadcaster.js";

const TTL_MS = 60_000; // 60 s max staleness — defence-in-depth against listener races
const _cache = new Map(); // userId → { data, ts }

let _initialized = false;

/** Register the ws_write invalidation listener. Idempotent — safe to call multiple times. */
export function initCoContextStore() {
  if (_initialized) return;
  _initialized = true;
  subscribe(({ event, data }) => {
    if (event === "ws_write" && data?.userId) {
      _cache.delete(data.userId);
    }
  });
}

export function getCachedContext(userId) {
  const entry = _cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    _cache.delete(userId);
    return null;
  }
  return entry.data;
}

export function setCachedContext(userId, data) {
  _cache.set(userId, { data, ts: Date.now() });
}

export function invalidateCachedContext(userId) {
  _cache.delete(userId);
}

export function cacheSize() {
  return _cache.size;
}

/** Expose for tests — returns internal map keys */
export function cachedUserIds() {
  return [..._cache.keys()];
}

/** Reset state between tests */
export function _resetForTests() {
  _cache.clear();
  _initialized = false;
}
