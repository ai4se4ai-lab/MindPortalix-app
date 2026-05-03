-- ── Workspace: per-user agent architecture, context injection, and directory hierarchy ──

-- Per-user file store (CLAUDE.md, MEMORY.md, 00_Resources/*, workstation dirs)
CREATE TABLE IF NOT EXISTS workspace_files (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  path         TEXT         NOT NULL,
  name         TEXT         NOT NULL,
  content      TEXT,
  mime_type    TEXT         DEFAULT 'text/plain',
  size_bytes   INTEGER      DEFAULT 0,
  is_directory BOOLEAN      DEFAULT false,
  created_at   TIMESTAMPTZ  DEFAULT now(),
  updated_at   TIMESTAMPTZ  DEFAULT now(),
  UNIQUE(user_id, path)
);
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own workspace files"
  ON workspace_files FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Per-user agent architecture (Mermaid diagram + agent overrides)
CREATE TABLE IF NOT EXISTS user_agent_configs (
  user_id        UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mermaid_diagram TEXT        NOT NULL DEFAULT '',
  agent_overrides JSONB       NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ  DEFAULT now()
);
ALTER TABLE user_agent_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own agent config"
  ON user_agent_configs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Per-user context injection rules
CREATE TABLE IF NOT EXISTS user_context_injection (
  user_id    UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rules      JSONB        NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ  DEFAULT now()
);
ALTER TABLE user_context_injection ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own context injection"
  ON user_context_injection FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
