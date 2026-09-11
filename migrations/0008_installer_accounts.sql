-- Preserve every existing account, verifier and session version while extending the role constraint.
CREATE TABLE erp_users_with_installer (
  username TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'pm', 'sales', 'specialist', 'installer')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);


INSERT INTO erp_users_with_installer (username, display_name, role, password_salt, password_hash, active, session_version, version, created_at, created_by, updated_at, updated_by) SELECT username, display_name, role, password_salt, password_hash, active, session_version, version, created_at, created_by, updated_at, updated_by FROM erp_users;
DROP TABLE erp_users;
ALTER TABLE erp_users_with_installer RENAME TO erp_users;
CREATE INDEX erp_users_active_role ON erp_users (active, role, username);

-- Initial installer accounts use independently salted scrypt verifiers.
INSERT INTO erp_users (username, display_name, role, password_salt, password_hash, active, session_version, version, created_at, created_by, updated_at, updated_by) VALUES
('leo', 'Leo', 'installer', 'c4RRLghfMcoUmqR4FzXkyA', 'YyVeGGm_ovjSvA2zIBBuszytzkgt4kHsgE4x32NRbqc', 1, 1, 1, '2026-09-07T03:06:08.273Z', 'system', '2026-09-07T03:06:08.273Z', 'system'),
('other', 'Other', 'installer', 'VONXN4FwN-qWV7U56RwqYg', 'IO8WBxAi4o0uj0VdkGZiOgBfJgiBg0HvAclxSZ22Zko', 1, 1, 1, '2026-09-07T03:06:08.273Z', 'system', '2026-09-07T03:06:08.273Z', 'system');
