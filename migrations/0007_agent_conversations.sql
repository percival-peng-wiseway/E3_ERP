PRAGMA foreign_keys = ON;

-- Privacy-first audit copy of the user-visible E3 Agent conversation.
-- The application only writes deterministically redacted, length-limited text;
-- hidden reasoning, raw tool payloads and raw attachment files have no columns here.
-- Visible answers may still contain business information derived from those sources.
CREATE TABLE IF NOT EXISTS erp_agent_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('admin', 'pm', 'sales', 'specialist')),
  conversation_key TEXT NOT NULL CHECK (length(conversation_key) BETWEEN 24 AND 64),
  trace_id TEXT,
  question_text TEXT NOT NULL CHECK (length(question_text) <= 2000),
  answer_text TEXT NOT NULL CHECK (length(answer_text) <= 8000),
  question_truncated INTEGER NOT NULL DEFAULT 0 CHECK (question_truncated IN (0, 1)),
  answer_truncated INTEGER NOT NULL DEFAULT 0 CHECK (answer_truncated IN (0, 1)),
  question_redaction_count INTEGER NOT NULL DEFAULT 0 CHECK (question_redaction_count >= 0),
  answer_redaction_count INTEGER NOT NULL DEFAULT 0 CHECK (answer_redaction_count >= 0)
);

CREATE INDEX IF NOT EXISTS erp_agent_conversations_created_at
  ON erp_agent_conversations (created_at DESC);

CREATE INDEX IF NOT EXISTS erp_agent_conversations_actor_created_at
  ON erp_agent_conversations (actor_username, created_at DESC);

CREATE INDEX IF NOT EXISTS erp_agent_conversations_conversation_created_at
  ON erp_agent_conversations (conversation_key, created_at ASC);

CREATE INDEX IF NOT EXISTS erp_agent_conversations_trace
  ON erp_agent_conversations (trace_id)
  WHERE trace_id IS NOT NULL;
