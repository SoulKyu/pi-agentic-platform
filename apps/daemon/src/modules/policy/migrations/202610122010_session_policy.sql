-- A session's own approval mode (D08) and its taint (stage 07, ADR 0020). No row, or a NULL mode: the owner's default.
-- `taint_epoch` grows by one at each clear; a worker lowers its taint only for a newer epoch (Task 9).
CREATE TABLE session_policy (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  approval_mode TEXT CHECK (approval_mode IS NULL OR approval_mode IN ('read-only', 'supervised', 'auto-accept-edits', 'full-access')),
  tainted_at INTEGER,
  taint_epoch INTEGER NOT NULL DEFAULT 0 CHECK (taint_epoch >= 0),
  updated_at INTEGER NOT NULL
) STRICT;

-- Nothing before M5 fenced external content, and adopted sessions cannot be told from pap's own: every session that
-- exists when this runs starts tainted (owner MQ3, agreement 8). One Clear per old session the owner continues.
INSERT INTO session_policy (session_id, owner_id, tainted_at, updated_at)
SELECT id, owner_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sessions;

-- The owner's policy settings (Settings › Approvals): one document, compare-and-set on `revision` like `settings`.
CREATE TABLE policy_settings (
  owner_id TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 65536),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL
) STRICT;
