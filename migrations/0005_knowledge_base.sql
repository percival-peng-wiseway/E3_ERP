PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS erp_knowledge_documents (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'e3'),
  file_id TEXT NOT NULL,
  file_version INTEGER NOT NULL CHECK (file_version >= 1),
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  document_type TEXT NOT NULL,
  category TEXT NOT NULL,
  language TEXT NOT NULL,
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
  version TEXT NOT NULL DEFAULT '1.0',
  index_generation INTEGER NOT NULL DEFAULT 1 CHECK (index_generation >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed', 'disabled')),
  access_scope TEXT NOT NULL DEFAULT 'company'
    CHECK (access_scope IN ('company', 'sales', 'pm', 'finance', 'admin')),
  product TEXT,
  region TEXT,
  effective_from TEXT,
  effective_to TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  last_indexed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  disabled_at TEXT,
  disabled_reason TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES erp_workspace_files(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, file_id),
  CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL AND disabled_reason IS NOT NULL)
    OR (status <> 'disabled' AND disabled_at IS NULL AND disabled_reason IS NULL)
  ),
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
);

CREATE INDEX IF NOT EXISTS erp_knowledge_documents_status
  ON erp_knowledge_documents (tenant_id, status, access_scope, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS erp_knowledge_documents_active_checksum
  ON erp_knowledge_documents (tenant_id, source_checksum)
  WHERE status <> 'disabled';

CREATE TABLE IF NOT EXISTS erp_knowledge_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'e3'),
  document_id TEXT NOT NULL,
  indexed_version TEXT NOT NULL,
  index_generation INTEGER NOT NULL CHECK (index_generation >= 1),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  index_item_key TEXT NOT NULL,
  index_item_id TEXT NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 1),
  heading_path_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(heading_path_json)),
  page_from INTEGER,
  page_to INTEGER,
  content_checksum TEXT NOT NULL CHECK (length(content_checksum) = 64),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  FOREIGN KEY (document_id) REFERENCES erp_knowledge_documents(id) ON DELETE CASCADE,
  UNIQUE (document_id, index_generation, chunk_index),
  UNIQUE (index_item_key),
  UNIQUE (index_item_id),
  CHECK (
    (page_from IS NULL AND page_to IS NULL)
    OR (page_from >= 1 AND page_to >= page_from)
  ),
  CHECK (
    (active = 1 AND invalidated_at IS NULL)
    OR (active = 0)
  )
);

CREATE INDEX IF NOT EXISTS erp_knowledge_chunks_active
  ON erp_knowledge_chunks (tenant_id, active, document_id, chunk_index);

CREATE INDEX IF NOT EXISTS erp_knowledge_chunks_document_version
  ON erp_knowledge_chunks (document_id, index_generation, chunk_index);

CREATE TABLE IF NOT EXISTS erp_knowledge_index_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'e3'),
  document_id TEXT NOT NULL,
  index_generation INTEGER NOT NULL CHECK (index_generation >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES erp_knowledge_documents(id) ON DELETE CASCADE,
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL)
    OR status <> 'running'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS erp_knowledge_index_jobs_one_active
  ON erp_knowledge_index_jobs (tenant_id, document_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS erp_knowledge_index_jobs_queue
  ON erp_knowledge_index_jobs (tenant_id, status, available_at, requested_at);
