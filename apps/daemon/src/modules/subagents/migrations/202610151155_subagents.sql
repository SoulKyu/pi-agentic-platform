-- Subagent runs (D11, ADR 0053): one row per `subagent` call, the child thread it made, and how it ended. The child is an
-- ordinary session (sessions.parent_session_id); the answer goes back to the parent's tool result, never stored here.
CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT UNIQUE,
  profile TEXT CHECK (profile IS NULL OR length(profile) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'done', 'failed', 'cancelled', 'interrupted')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 64),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK ((state IN ('done', 'failed', 'cancelled', 'interrupted')) = (ended_at IS NOT NULL))
) STRICT;
CREATE INDEX subagent_runs_parent ON subagent_runs(parent_session_id, started_at);
CREATE INDEX subagent_runs_live ON subagent_runs(owner_id, state) WHERE state IN ('starting', 'running');
