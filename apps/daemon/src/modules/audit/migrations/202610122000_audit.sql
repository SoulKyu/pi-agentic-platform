-- The audit trail (spec C §3.4, §5.1), append-only. One row per judged tool call, per executed result and per worker
-- start, with the stage verdicts in `stages` (ADR 0022), and one per security-relevant change (auth, policy). Results are
-- never stored; arguments arrive redacted, escaped and clipped. Rows leave only through `pap audit prune`, a whole month
-- older than 12 months at a time, and the prune leaves its own row. The triggers stop a bug, not a person who can edit
-- the file.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  month TEXT NOT NULL CHECK (month = strftime('%Y-%m', at / 1000, 'unixepoch')),
  owner_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('worker', 'user', 'token', 'cli', 'system')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 128),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'result', 'session', 'invalid', 'auth', 'policy', 'audit')),
  session_id TEXT CHECK (session_id IS NULL OR length(session_id) <= 128),
  tool_call_id TEXT CHECK (tool_call_id IS NULL OR length(tool_call_id) <= 256),
  parent_tool_call_id TEXT CHECK (parent_tool_call_id IS NULL OR length(parent_tool_call_id) <= 256),
  tool TEXT CHECK (tool IS NULL OR length(tool) <= 256),
  category TEXT CHECK (category IS NULL OR length(category) <= 32),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'approved', 'denied', 'info')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1024),
  stages TEXT CHECK (stages IS NULL OR (json_valid(stages) AND length(stages) <= 4096)),
  args TEXT CHECK (args IS NULL OR length(args) <= 8192),
  detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 4096))
) STRICT;

CREATE INDEX audit_month ON audit(month, id);
CREATE INDEX audit_owner ON audit(owner_id, id);
CREATE INDEX audit_session ON audit(session_id, id) WHERE session_id IS NOT NULL;

CREATE TABLE audit_prunes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  state TEXT NOT NULL CHECK (state IN ('open', 'done')),
  rows INTEGER NOT NULL DEFAULT 0 CHECK (rows >= 0),
  at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER audit_delete_only_pruned BEFORE DELETE ON audit
WHEN NOT EXISTS (SELECT 1 FROM audit_prunes WHERE month = OLD.month AND state = 'open')
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER audit_prunes_old_months_only BEFORE INSERT ON audit_prunes
WHEN NEW.state <> 'open' OR NEW.month >= strftime('%Y-%m', 'now', 'start of month', '-12 months')
BEGIN SELECT RAISE(ABORT, 'only a month older than 12 months can be pruned'); END;

CREATE TRIGGER audit_prunes_close_once BEFORE UPDATE ON audit_prunes
WHEN OLD.state <> 'open' OR NEW.state <> 'done' OR NEW.month <> OLD.month OR NEW.id <> OLD.id OR NEW.at <> OLD.at
BEGIN SELECT RAISE(ABORT, 'audit_prunes is append-only'); END;

CREATE TRIGGER audit_prunes_no_delete BEFORE DELETE ON audit_prunes
BEGIN SELECT RAISE(ABORT, 'audit_prunes is append-only'); END;
