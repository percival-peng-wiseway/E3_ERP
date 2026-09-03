PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS erp_agent_traces (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  workflow TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'fallback', 'error')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  prompt_version TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skills_json)),
  toolsets_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(toolsets_json)),
  memory_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(memory_keys_json)),
  steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps_json)),
  tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools_json)),
  model_rounds_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(model_rounds_json)),
  abstained INTEGER NOT NULL DEFAULT 0 CHECK (abstained IN (0, 1)),
  actor_username TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('admin', 'pm', 'sales', 'specialist')),
  conversation_key TEXT,
  message_length INTEGER NOT NULL CHECK (message_length BETWEEN 0 AND 2000),
  history_message_count INTEGER NOT NULL CHECK (history_message_count BETWEEN 0 AND 20),
  attachment_count INTEGER NOT NULL CHECK (attachment_count BETWEEN 0 AND 10),
  request_language TEXT NOT NULL CHECK (request_language IN ('chinese', 'english', 'mixed', 'other')),
  data_source TEXT NOT NULL,
  model_status TEXT NOT NULL CHECK (model_status IN ('available', 'unavailable', 'not_checked')),
  issue_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issue_codes_json))
);

CREATE INDEX IF NOT EXISTS erp_agent_traces_created_at
  ON erp_agent_traces (created_at DESC);

CREATE INDEX IF NOT EXISTS erp_agent_traces_outcome_workflow
  ON erp_agent_traces (outcome, workflow, created_at DESC);

CREATE INDEX IF NOT EXISTS erp_agent_traces_actor_created_at
  ON erp_agent_traces (actor_username, created_at DESC);

CREATE INDEX IF NOT EXISTS erp_agent_traces_conversation
  ON erp_agent_traces (conversation_key, created_at ASC)
  WHERE conversation_key IS NOT NULL;
