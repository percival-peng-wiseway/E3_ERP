CREATE TABLE IF NOT EXISTS erp_users (
  username TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'pm', 'sales', 'specialist')),
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

CREATE INDEX IF NOT EXISTS erp_users_active_role
  ON erp_users (active, role, username);

INSERT OR IGNORE INTO erp_users
  (username, display_name, role, password_salt, password_hash, active, session_version, version, created_at, created_by, updated_at, updated_by)
VALUES
  ('jerry', 'Jerry', 'admin', 'u6ZRfR-mSgxr4jE8rIgG0g', '8KL4JTzjMs3H7-ohzSINJmVTsv9GUmPNRw3d-he2SQE', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('jiaqi', 'Jiaqi', 'admin', 'UABndEoYw_a6x478-F1kGQ', 'IgkoGnIV8cwon2Ku7pSwisUb-puG7XDnuLXYkX0olzU', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('wendy', 'Wendy', 'pm', 'r3bn02cgBdgnQArpYHCjQg', 'YtvgZDTBA1FOVgqfEIfyoaX9nerWc7AeRYJ05Uas4iA', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('kevin', 'Kevin', 'pm', 'b2NnVZYS4nobKNj9rgJaQA', 'AkenQ3xSpuCoMawcfBrqICSei7p2RMvBgzdtBR8tVDo', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('daniel', 'Daniel', 'pm', 's88y0DC3Ogk_EA0zkDyf5A', 'FZ4-TRKvHQW_KXYlh9s3bM9vDzPybhVjPfdEJfp2bS8', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('sam', 'Sam', 'sales', 'ojR3tLtbnBHl8PQotDZL5w', 'jAOEkSMaVhHwTntp0rsc7NsvYWDZYaS8pV9mpq2d7D0', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('ruihan', 'Ruihan', 'sales', 'eElq7KgqFzN-JESkw1DDDg', '6qmZxA_8iJRb6m6W5Y2CxrvsrBhHtY2VPePqH3fqvaY', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('hogan', 'Hogan', 'pm', 'p_ZBcrZWF0yiciHRoyW4rQ', 'srIqjv2ofGOlUZ1UkDPwpTw2fIz4DSFUESTVzCM2oL0', 1, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('percival', 'Percival', 'admin', 'AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system'),
  ('steve', 'Steve', 'admin', 'AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0, 1, 1, '2026-08-25T00:00:00.000Z', 'system', '2026-08-25T00:00:00.000Z', 'system');
