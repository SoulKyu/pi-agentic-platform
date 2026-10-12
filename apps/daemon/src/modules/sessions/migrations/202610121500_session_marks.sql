-- M4: how the sidebar files a session (D02, Sessions+), its project, and the start of its first message for its label.
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN preview TEXT CHECK (preview IS NULL OR length(preview) <= 120);
ALTER TABLE sessions ADD COLUMN pin_rank INTEGER CHECK (pin_rank IS NULL OR pin_rank BETWEEN 1 AND 50);
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_auto INTEGER NOT NULL DEFAULT 0 CHECK (settled_auto IN (0, 1));
ALTER TABLE sessions ADD COLUMN unsettled_at INTEGER;
ALTER TABLE sessions ADD COLUMN snoozed_until INTEGER;
-- The first Pi session id a worker reported at `ready` while its row had no Pi file yet (RT-01). Never overwritten by a
-- later one; every id reported lives in `session_pending_ids`, which is what the scanner reads. Not `pi_session_id`: the
-- CHECK pairs that one with `pi_path`.
ALTER TABLE sessions ADD COLUMN pending_pi_session_id TEXT
  CHECK (pending_pi_session_id IS NULL OR length(pending_pi_session_id) BETWEEN 1 AND 128);

-- Every Pi id the workers of one draft reported (M4R60): a draft prompted again after a crash gets a new worker with a
-- new id, and the first worker's file still binds back to the draft, under its own owner. At most 32 per session.
CREATE TABLE session_pending_ids (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pi_session_id TEXT NOT NULL CHECK (length(pi_session_id) BETWEEN 1 AND 128),
  PRIMARY KEY (pi_session_id, session_id)
) WITHOUT ROWID;

CREATE INDEX sessions_pi_session_id ON sessions(pi_session_id) WHERE pi_session_id IS NOT NULL;
CREATE INDEX sessions_pending_pi_session_id ON sessions(pending_pi_session_id) WHERE pending_pi_session_id IS NOT NULL;
CREATE INDEX sessions_owner_active ON sessions(owner_id, archived_at, updated_at DESC);
CREATE INDEX sessions_owner_project ON sessions(owner_id, project_id);
CREATE INDEX sessions_snoozed ON sessions(snoozed_until) WHERE snoozed_until IS NOT NULL;
