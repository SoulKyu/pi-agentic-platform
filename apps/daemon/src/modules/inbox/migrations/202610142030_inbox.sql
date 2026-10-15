-- The Inbox (decision 29, ADR 0041): what M10 puts there is about automation tasks; M11 adds agent items (no closed list of kinds).
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  to_handle INTEGER NOT NULL CHECK (to_handle IN (0, 1)),
  task_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 320),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  resolved_at INTEGER,
  -- How a question left "To handle": answered by a person, or denied when nobody answered in time (owner m10a3).
  resolution TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 32),
  CHECK (resolution IS NULL OR resolved_at IS NOT NULL)
) STRICT;

CREATE INDEX inbox_owner ON inbox_items(owner_id, created_at);
-- One row per task and kind: a second question of the same task reopens the row (RT-11), it never adds one.
CREATE UNIQUE INDEX inbox_task_kind ON inbox_items(task_id, kind) WHERE task_id IS NOT NULL;
