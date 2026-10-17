CREATE TABLE push_subs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'fr')),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  UNIQUE (owner_id, endpoint_hash)
) STRICT;
CREATE INDEX push_subs_owner ON push_subs (owner_id);
-- The owner revoked this endpoint (W6-R15): a refresh of it is refused, so a revoked device that is still signed in does not
-- enrol itself again at its next open. A hash only, the newest 50 per owner; a new Enable makes a new endpoint.
CREATE TABLE push_revoked (
  owner_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, endpoint_hash)
) STRICT;
CREATE TABLE push_events (
  id TEXT PRIMARY KEY,                -- randomToken(16): 22 base64url characters, also the wire id and the Topic
  owner_id TEXT NOT NULL,
  cls TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  name TEXT,                          -- a registry name (trigger_name or agent name) only, used only when titles = names
  dedup_key TEXT NOT NULL,            -- push:<cls>:<ref_kind>:<ref_id>; unique only while live (below); NEVER the outbox key
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'suppressed', 'held', 'digested', 'cancelled', 'failed')),
  reason TEXT,
  rechecks INTEGER NOT NULL DEFAULT 0, -- focus re-checks of an approval (at most 3)
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;
CREATE INDEX push_events_owner_state ON push_events (owner_id, state);
CREATE INDEX push_events_ref ON push_events (owner_id, ref_kind, ref_id);
CREATE UNIQUE INDEX push_events_dedup ON push_events (dedup_key) WHERE state IN ('pending', 'held');
CREATE TABLE push_deliveries (
  event_id TEXT NOT NULL,
  sub_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'gone', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  reason TEXT,                        -- a reason class: retry_exhausted, rejected, refused; never a response body
  PRIMARY KEY (event_id, sub_id)
) STRICT;
CREATE TABLE push_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;  -- keys_reset (A), last_failure (B)
