CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
) STRICT;

CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
