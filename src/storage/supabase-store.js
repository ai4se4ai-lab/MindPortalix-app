import { createClient } from "@supabase/supabase-js";

function isSecretPlaceholder(secretKey) {
  return !secretKey || secretKey.includes("your-key") || secretKey === "undefined";
}

/**
 * Server-side DB access must satisfy RLS (`auth.uid()`).
 * With the anon/publishable key, PostgREST needs the user's JWT on each request.
 * With `SUPABASE_SECRET_KEY` (service role), RLS is bypassed — no user JWT required.
 *
 * @param {string | null | undefined} accessToken User JWT from `Authorization` (Bearer); required for anon key.
 */
function getSupabaseClient(accessToken = null) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const usingPublishableOnly = isSecretPlaceholder(secretKey);
  const key = usingPublishableOnly
    ? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    : secretKey;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and a Supabase key are required");
  }
  const options = { auth: { persistSession: false } };
  if (usingPublishableOnly && accessToken) {
    options.global = { headers: { Authorization: `Bearer ${accessToken}` } };
  }
  return createClient(url, key, options);
}

/**
 * Detect Supabase "table does not exist" / schema-not-ready errors.
 * These happen when the migration hasn't been run yet.
 */
function isSchemaError(error) {
  if (!error) return false;
  const msg = error.message ?? "";
  return (
    msg.includes("schema cache") ||
    msg.includes("does not exist") ||
    msg.includes("relation") ||
    error.code === "42P01" ||   // PostgreSQL: undefined table
    error.code === "PGRST200"   // PostgREST: schema cache miss
  );
}

let _schemaMissingWarned = false;
function warnSchemaMissing() {
  if (_schemaMissingWarned) return;
  _schemaMissingWarned = true;
  console.warn(
    "\n[db] ⚠ Supabase tables not found. Run the migration to enable persistence:\n" +
    "  Option A — Supabase CLI:  npx supabase db push\n" +
    "  Option B — Dashboard SQL: paste contents of supabase/migrations/*.sql\n" +
    "  (Chat responses still work — using in-memory fallback for this session)\n"
  );
}

export class SupabaseMemoryStore {
  /** @param {string | null | undefined} accessToken User JWT when using anon key + RLS */
  constructor(accessToken = null) {
    this._accessToken = accessToken ?? null;
    this._client = null;
  }

  get client() {
    if (!this._client) this._client = getSupabaseClient(this._accessToken);
    return this._client;
  }

  async search({ userId, query, limit = 5 }) {
    const terms = tokenize(query);
    const { data, error } = await this.client
      .from("memories")
      .select("*")
      .eq("user_id", userId)
      .order("importance", { ascending: false })
      .order("last_accessed", { ascending: false })
      .limit(20);

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return []; }
      throw new Error(`Memory search failed: ${error.message}`);
    }

    return (data ?? [])
      .map((row) => ({ ...toMemoryRecord(row), relevance: relevanceScore(row, terms) }))
      .filter((r) => r.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.importance - a.importance)
      .slice(0, limit);
  }

  async write(record) {
    const row = toSupabaseRow(record);
    const { data, error } = await this.client
      .from("memories")
      .insert(row)
      .select()
      .single();

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return null; }
      throw new Error(`Memory write failed: ${error.message}`);
    }
    return toMemoryRecord(data);
  }

  async all(userId) {
    const { data, error } = await this.client
      .from("memories")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return []; }
      throw new Error(`Memory list failed: ${error.message}`);
    }
    return (data ?? []).map(toMemoryRecord);
  }

  async saveMessage({ conversationId, userId, role, content, agent, model, score }) {
    const { data, error } = await this.client
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: userId, role, content, agent, model, score })
      .select()
      .single();

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return null; }
      throw new Error(`Message save failed: ${error.message}`);
    }

    // Bump updated_at on the parent conversation so listConversations sorts by activity
    await this.client
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("user_id", userId);

    return data;
  }

  async getMessages(conversationId, userId) {
    // Build all WHERE filters before calling .order() — Supabase JS v2 returns a
    // PostgrestTransformBuilder from .order() which does not expose .eq(), so all
    // filter methods must be chained before the transform step.
    let builder = this.client
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId);

    // Explicit user_id guard when using service-role key (RLS is bypassed in that mode)
    if (userId) builder = builder.eq("user_id", userId);

    const { data, error } = await builder.order("created_at", { ascending: true });
    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return []; }
      throw new Error(`Messages fetch failed: ${error.message}`);
    }
    return data ?? [];
  }

  async createConversation({ userId, title }) {
    const { data, error } = await this.client
      .from("conversations")
      .insert({ user_id: userId, title: title ?? "New conversation" })
      .select()
      .single();

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return null; }
      throw new Error(`Conversation create failed: ${error.message}`);
    }
    return data;
  }

  async listConversations(userId) {
    const { data, error } = await this.client
      .from("conversations")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) {
      if (isSchemaError(error)) { warnSchemaMissing(); return []; }
      throw new Error(`Conversations list failed: ${error.message}`);
    }
    return data ?? [];
  }

  async deleteConversation(conversationId) {
    const { error } = await this.client
      .from("conversations")
      .delete()
      .eq("id", conversationId);

    if (error && !isSchemaError(error)) {
      throw new Error(`Conversation delete failed: ${error.message}`);
    }
  }
}

function toMemoryRecord(row) {
  return {
    id: row.id,
    userId: row.user_id,
    topic: row.topic,
    summary: row.summary,
    importance: row.importance,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed
  };
}

function toSupabaseRow(record) {
  return {
    user_id: record.userId,
    topic: record.topic ?? "general",
    summary: record.summary ?? "",
    importance: record.importance ?? 3
  };
}

function relevanceScore(row, terms) {
  const haystack = `${row.topic ?? ""} ${row.summary ?? ""}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) + (row.importance ?? 3) / 10;
}

function tokenize(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}
