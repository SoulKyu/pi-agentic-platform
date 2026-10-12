-- M4: how the sidebar files a session (D02, Sessions+), its project, and the start of its first message for its label.
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN preview TEXT CHECK (preview IS NULL OR length(preview) <= 120);
ALTER TABLE sessions ADD COLUMN pin_rank INTEGER CHECK (pin_rank IS NULL OR pin_rank BETWEEN 1 AND 50);
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_auto INTEGER NOT NULL DEFAULT 0 CHECK (settled_auto IN (0, 1));
ALTER TABLE sessions ADD COLUMN unsettled_at INTEGER;
ALTER TABLE sessions ADD COLUMN snoozed_until INTEGER;
-- The Pi session id a worker reported at `ready` while its row had no Pi file yet (RT-01): after a restart the scanner
-- binds that file back to this draft, under its own owner. Not `pi_session_id`: the CHECK pairs that one with `pi_path`.
ALTER TABLE sessions ADD COLUMN pending_pi_session_id TEXT
  CHECK (pending_pi_session_id IS NULL OR length(pending_pi_session_id) BETWEEN 1 AND 128);

CREATE INDEX sessions_pi_session_id ON sessions(pi_session_id) WHERE pi_session_id IS NOT NULL;
CREATE INDEX sessions_pending_pi_session_id ON sessions(pending_pi_session_id) WHERE pending_pi_session_id IS NOT NULL;
CREATE INDEX sessions_owner_active ON sessions(owner_id, archived_at, updated_at DESC);
CREATE INDEX sessions_owner_project ON sessions(owner_id, project_id);
CREATE INDEX sessions_snoozed ON sessions(snoozed_until) WHERE snoozed_until IS NOT NULL;
