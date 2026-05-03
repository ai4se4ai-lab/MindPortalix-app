-- Add updated_at to conversations so the history list sorts by recent activity
-- (When a message is added to a conversation, updated_at is bumped server-side)

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Back-fill: set updated_at = created_at for existing rows
UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL;

-- Index for the ORDER BY updated_at DESC used in listConversations
CREATE INDEX IF NOT EXISTS conversations_user_id_updated_at_idx
  ON conversations (user_id, updated_at DESC);
