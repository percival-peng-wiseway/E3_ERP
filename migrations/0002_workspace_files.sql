CREATE TABLE IF NOT EXISTS erp_workspace_files (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL CHECK (workspace_id = 'company'),
  parent_id TEXT,
  parent_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  checksum TEXT,
  storage_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  trashed_at TEXT,
  trashed_by TEXT,
  trash_root_id TEXT,
  FOREIGN KEY (parent_id) REFERENCES erp_workspace_files(id),
  CHECK (
    (parent_id IS NULL AND parent_key = '')
    OR (parent_id IS NOT NULL AND parent_key = parent_id)
  ),
  CHECK (
    (kind = 'folder' AND content_type IS NULL AND size_bytes IS NULL AND checksum IS NULL AND storage_key IS NULL)
    OR (kind = 'file' AND content_type IS NOT NULL AND size_bytes >= 1 AND length(checksum) = 64 AND storage_key IS NOT NULL)
  ),
  CHECK (
    (trashed_at IS NULL AND trashed_by IS NULL AND trash_root_id IS NULL)
    OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL AND trash_root_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS erp_workspace_files_live_name
  ON erp_workspace_files (workspace_id, parent_key, name_key)
  WHERE trashed_at IS NULL;

CREATE INDEX IF NOT EXISTS erp_workspace_files_parent
  ON erp_workspace_files (workspace_id, parent_key, trashed_at, kind, name_key);

CREATE INDEX IF NOT EXISTS erp_workspace_files_owner
  ON erp_workspace_files (workspace_id, owner_username, trashed_at, updated_at);

CREATE INDEX IF NOT EXISTS erp_workspace_files_trash_root
  ON erp_workspace_files (workspace_id, trash_root_id);
