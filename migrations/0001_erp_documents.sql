CREATE TABLE IF NOT EXISTS erp_documents (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL
);
