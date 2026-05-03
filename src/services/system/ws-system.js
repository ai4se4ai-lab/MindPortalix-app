/**
 * WS System Services — raw database access for workspace tables.
 * No Express. No HTTP. Accepts a Supabase client directly.
 * All workspace DB operations live here. Route handlers delegate to these functions.
 */
import { DEFAULT_MERMAID, DEFAULT_CONTEXT_INJECTION, DEFAULT_CLAUDE_MD, DEFAULT_MEMORY_MD } from "../../lib/defaults.js";

// ── Agent config ──────────────────────────────────────────────────────────────

export async function dbGetAgentConfig(client, userId) {
  const { data } = await client
    .from("user_agent_configs")
    .select("mermaid_diagram, agent_overrides")
    .eq("user_id", userId)
    .single();
  return data ?? { mermaid_diagram: DEFAULT_MERMAID, agent_overrides: {} };
}

export async function dbUpsertAgentConfig(client, userId, { mermaid_diagram, agent_overrides }) {
  const { error } = await client.from("user_agent_configs").upsert(
    { user_id: userId, mermaid_diagram, agent_overrides: agent_overrides ?? {}, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message);
}

// ── Context injection ─────────────────────────────────────────────────────────

export async function dbGetContextInjection(client, userId) {
  const { data } = await client
    .from("user_context_injection")
    .select("rules")
    .eq("user_id", userId)
    .single();
  return { rules: data?.rules ?? DEFAULT_CONTEXT_INJECTION };
}

export async function dbUpsertContextInjection(client, userId, rules) {
  const { error } = await client.from("user_context_injection").upsert(
    { user_id: userId, rules, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message);
}

// ── Workspace files ───────────────────────────────────────────────────────────

export async function dbGetFiles(client, userId) {
  const { data, error } = await client
    .from("workspace_files")
    .select("id, path, name, mime_type, size_bytes, is_directory, created_at, updated_at")
    .eq("user_id", userId)
    .not("path", "like", "_context/%")
    .order("path");
  if (error) throw new Error(error.message);
  return (data ?? []).filter(f => !f.path.startsWith("_context/"));
}

export async function dbGetFile(client, userId, filePath) {
  const { data, error } = await client
    .from("workspace_files")
    .select("*")
    .eq("user_id", userId)
    .eq("path", filePath)
    .single();
  if (error || !data) return null;
  return data;
}

export async function dbUpsertFile(client, userId, filePath, { content, mime_type }) {
  const name = filePath.split("/").pop();
  const { error } = await client.from("workspace_files").upsert(
    {
      user_id: userId,
      path: filePath,
      name,
      content: content ?? "",
      mime_type: mime_type ?? "text/plain",
      size_bytes: content ? content.length : 0,
      is_directory: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,path" }
  );
  if (error) throw new Error(error.message);
}

export async function dbDeleteFile(client, userId, filePath) {
  const [r1, r2] = await Promise.all([
    client.from("workspace_files").delete().eq("user_id", userId).eq("path", filePath),
    client.from("workspace_files").delete().eq("user_id", userId).like("path", `${filePath}/%`),
  ]);
  const err = r1.error ?? r2.error;
  if (err) throw new Error(err.message);
}

export async function dbUploadFile(client, userId, { name, content, mime_type, directory = "00_Resources" }) {
  const ext = name.split(".").pop()?.toLowerCase();
  const allowed = ["md", "pdf", "csv", "txt", "py"];
  if (!allowed.includes(ext)) throw new Error(`Only ${allowed.join(", ")} files are allowed`);

  const filePath = `${directory}/${name}`;
  const textExts = new Set(["md", "txt", "csv", "py"]);
  const resolvedMime = textExts.has(ext)
    ? (mime_type?.startsWith("text/") ? mime_type : "text/plain")
    : (mime_type ?? "application/octet-stream");

  const { error } = await client.from("workspace_files").upsert(
    { user_id: userId, path: filePath, name, content, mime_type: resolvedMime,
      size_bytes: content.length, is_directory: false, updated_at: new Date().toISOString() },
    { onConflict: "user_id,path" }
  );
  if (error) throw new Error(error.message);
  return filePath;
}

// ── Workspace initialization ──────────────────────────────────────────────────

export async function dbInitWorkspace(client, userId) {
  const now = new Date().toISOString();
  await Promise.all([
    client.from("user_agent_configs").upsert(
      { user_id: userId, mermaid_diagram: DEFAULT_MERMAID, agent_overrides: {} },
      { onConflict: "user_id", ignoreDuplicates: true }
    ),
    client.from("user_context_injection").upsert(
      { user_id: userId, rules: DEFAULT_CONTEXT_INJECTION },
      { onConflict: "user_id", ignoreDuplicates: true }
    ),
    ...[
      { path: "CLAUDE.md",    name: "CLAUDE.md",    content: DEFAULT_CLAUDE_MD,  mime_type: "text/markdown",  is_directory: false },
      { path: "MEMORY.md",    name: "MEMORY.md",    content: DEFAULT_MEMORY_MD,  mime_type: "text/markdown",  is_directory: false },
      { path: "00_Resources", name: "00_Resources", content: null,               mime_type: null,             is_directory: true  },
    ].map(f =>
      client.from("workspace_files").upsert(
        { user_id: userId, ...f, size_bytes: f.content ? f.content.length : 0, updated_at: now },
        { onConflict: "user_id,path", ignoreDuplicates: true }
      )
    ),
  ]);
}

export async function dbCreateDirectory(client, userId, safeName) {
  const now = new Date().toISOString();
  const uo  = { onConflict: "user_id,path", ignoreDuplicates: true };

  const results = await Promise.all([
    client.from("workspace_files").upsert(
      { user_id: userId, path: safeName, name: safeName, content: null, mime_type: null, size_bytes: 0, is_directory: true, updated_at: now }, uo
    ),
    client.from("workspace_files").upsert(
      { user_id: userId, path: `${safeName}/CLAUDE.md`,    name: "CLAUDE.md",    content: DEFAULT_CLAUDE_MD,  mime_type: "text/markdown", size_bytes: DEFAULT_CLAUDE_MD.length,  is_directory: false, updated_at: now }, uo
    ),
    client.from("workspace_files").upsert(
      { user_id: userId, path: `${safeName}/MEMORY.md`,    name: "MEMORY.md",    content: DEFAULT_MEMORY_MD,  mime_type: "text/markdown", size_bytes: DEFAULT_MEMORY_MD.length,  is_directory: false, updated_at: now }, uo
    ),
    client.from("workspace_files").upsert(
      { user_id: userId, path: `${safeName}/00_Resources`, name: "00_Resources", content: null, mime_type: null, size_bytes: 0, is_directory: true, updated_at: now }, uo
    ),
  ]);

  const err = results.find(r => r.error)?.error;
  if (err) throw new Error(err.message);
  return safeName;
}

// ── Full context assembly (used by CO system to populate the cache) ────────────

export async function dbGetWorkspaceContext(client, userId) {
  const [agentCfg, ctxInj, files] = await Promise.all([
    client.from("user_agent_configs").select("mermaid_diagram, agent_overrides").eq("user_id", userId).single(),
    client.from("user_context_injection").select("rules").eq("user_id", userId).single(),
    client.from("workspace_files").select("path, name, content, mime_type, is_directory").eq("user_id", userId).order("path"),
  ]);

  const allFiles = files.data ?? [];
  const claudeMd = allFiles.find(f => f.path === "CLAUDE.md")?.content ?? "";
  const memoryMd = allFiles.find(f => f.path === "MEMORY.md")?.content ?? "";
  const resources = allFiles
    .filter(f => !f.is_directory && !f.path.startsWith("_context/") && f.path !== "CLAUDE.md" && f.path !== "MEMORY.md")
    .map(f => ({
      path: f.path,
      name: f.name,
      mime_type: f.mime_type,
      content: (f.mime_type?.startsWith("text/") || f.mime_type === "application/json")
        ? (f.content ?? "").slice(0, 8192)
        : null,
    }));

  return {
    mermaidDiagram:   agentCfg.data?.mermaid_diagram ?? DEFAULT_MERMAID,
    agentOverrides:   agentCfg.data?.agent_overrides ?? {},
    contextInjection: ctxInj.data?.rules             ?? DEFAULT_CONTEXT_INJECTION,
    claudeMd,
    memoryMd,
    resources,
    files: allFiles
      .filter(f => !f.path.startsWith("_context/"))
      .map(f => ({ path: f.path, name: f.name, is_directory: f.is_directory, mime_type: f.mime_type })),
    contextFiles: allFiles
      .filter(f => f.path.startsWith("_context/") && !f.is_directory)
      .map(f => ({ path: f.path, content: f.content })),
  };
}
