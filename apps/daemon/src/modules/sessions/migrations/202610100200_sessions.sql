-- A session has its own id. Pi writes a session's file only when its first user message is recorded (S1, R37), so
-- `pi_path` and `pi_session_id` stay NULL for a draft and are set once, when the file exists.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pi_path TEXT,
  pi_session_id TEXT,
  cwd TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((pi_path IS NULL) = (pi_session_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX sessions_pi_path ON sessions(pi_path) WHERE pi_path IS NOT NULL;
CREATE INDEX sessions_owner ON sessions(owner_id, updated_at DESC);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX session_events_session ON session_events(session_id, id);
