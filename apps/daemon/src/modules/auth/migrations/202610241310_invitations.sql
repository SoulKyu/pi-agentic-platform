CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name_hint TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
) STRICT;

CREATE TABLE invite_throttle (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
) STRICT;
