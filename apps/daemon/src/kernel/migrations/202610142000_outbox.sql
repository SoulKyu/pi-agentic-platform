-- The outbox (spec C §6.2, ADR 0040). An effect is written in the transaction of the state change that implies it, and
-- the worker in the daemon carries it out. `replay` is fixed per kind by the code and stored on the row, so recovery
-- reads the class from the row, never from a kind this binary may not know any more.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  replay TEXT NOT NULL CHECK (replay IN ('process-bound', 'replay-safe')),
  -- Whose effect it is: the failures banner and Dismiss show an owner only their own rows. NULL: a system effect
  -- (`attachment.cleanup`), which holds no owner data.
  owner_id TEXT CHECK (owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 128),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  -- A receipt against duplicates: a second effect with the same key is never written.
  dedup_key TEXT UNIQUE CHECK (dedup_key IS NULL OR length(dedup_key) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'done', 'failed', 'retired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_at INTEGER NOT NULL CHECK (next_at >= 0),
  lease_until INTEGER,
  -- A cancel that came while the effect was leased: its handler reads it right before the step it cannot undo.
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  -- The handler passed its point of no return (a resume's prompt is about to be sent): after a crash the row is
  -- retired like a process-bound one, never replayed.
  sent_at INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
  -- A failed effect stays until the owner dismisses it (C §3.4: "failed rows are kept until resolved").
  dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  CHECK ((status = 'leased') = (lease_until IS NOT NULL)),
  CHECK ((status IN ('done', 'failed', 'retired')) = (settled_at IS NOT NULL)),
  CHECK (sent_at IS NULL OR status <> 'pending')
) STRICT;

CREATE INDEX outbox_due ON outbox(next_at, id) WHERE status = 'pending';
CREATE INDEX outbox_settled ON outbox(settled_at) WHERE settled_at IS NOT NULL;
CREATE INDEX outbox_failed ON outbox(owner_id, settled_at) WHERE status = 'failed' AND dismissed = 0;
