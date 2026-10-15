-- Automation (spec C §6, D13, ADR 0041): triggers, the fire journal, tasks and the feed's seen entries. A trigger's
-- secret is never here: it lives in $PAP_HOME/secrets/triggers/<id>.key (0600, C §3.1).
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 320),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  source_type TEXT NOT NULL CHECK (source_type IN ('schedule', 'webhook', 'feed', 'manual')),
  -- The validated `TriggerInput` (contracts) as JSON, parsed again at every read: a row that does not parse never fires.
  config TEXT NOT NULL CHECK (json_valid(config) AND length(config) <= 65536),
  cwd TEXT NOT NULL CHECK (length(cwd) BETWEEN 1 AND 4096),
  project_id TEXT,
  secret_rotated_at INTEGER,
  next_fire_at INTEGER,
  last_fire_at INTEGER,
  -- When a task of this trigger last started: the runner admits round-robin by trigger, oldest start first (RT-10).
  last_start_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX triggers_owner ON triggers(owner_id, created_at);
CREATE INDEX triggers_due ON triggers(next_fire_at) WHERE enabled = 1 AND next_fire_at IS NOT NULL;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  -- schedule, webhook, feed, manual, retry in M10; M11 adds delegate and remind.
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 32),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'limited', 'done', 'failed', 'cancelled', 'interrupted')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 64),
  cwd TEXT NOT NULL CHECK (length(cwd) BETWEEN 1 AND 4096),
  -- The prompt as it will be sent, fenced input included. Never logged, never on a stream.
  prompt TEXT NOT NULL CHECK (length(prompt) <= 131072),
  tainted INTEGER NOT NULL CHECK (tainted IN (0, 1)),
  -- The daily budget gates this task's start and aborts its run when crossed; 0: a browser's manual fire (owner m10q5).
  gated INTEGER NOT NULL DEFAULT 1 CHECK (gated IN (0, 1)),
  -- { mode, tools, preset, env } as the trigger said when it fired: a later edit of the trigger does not change a fired task.
  policy TEXT NOT NULL CHECK (json_valid(policy) AND length(policy) <= 8192),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 320),
  -- A short line taken from the payload: untrusted text, shown fenced.
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 512),
  session_id TEXT,
  retry_of TEXT,
  retry_on_interrupt INTEGER NOT NULL DEFAULT 0 CHECK (retry_on_interrupt IN (0, 1)),
  max_run_ms INTEGER NOT NULL CHECK (max_run_ms BETWEEN 60000 AND 14400000),
  max_run_usd REAL CHECK (max_run_usd IS NULL OR max_run_usd > 0),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  CHECK ((state IN ('done', 'failed', 'cancelled', 'interrupted')) = (ended_at IS NOT NULL))
) STRICT;

CREATE INDEX tasks_owner_state ON tasks(owner_id, state, created_at);
CREATE INDEX tasks_trigger ON tasks(trigger_id, created_at) WHERE trigger_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_session ON tasks(session_id) WHERE session_id IS NOT NULL;

-- Terminal states never change (C §6.1). Only `trigger_id` may still move, to NULL, when its trigger is deleted.
CREATE TRIGGER tasks_terminal_immutable BEFORE UPDATE ON tasks
WHEN OLD.state IN ('done', 'failed', 'cancelled', 'interrupted')
  AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.ended_at IS NOT OLD.ended_at
    OR NEW.started_at IS NOT OLD.started_at OR NEW.session_id IS NOT OLD.session_id OR NEW.title IS NOT OLD.title
    OR NEW.prompt IS NOT OLD.prompt OR NEW.policy IS NOT OLD.policy OR NEW.gated IS NOT OLD.gated
    OR (NEW.trigger_id IS NOT OLD.trigger_id AND NEW.trigger_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'a finished task does not change'); END;

-- The fire journal (C §3.4: 500 entries per trigger). A verdict equal to the last row's (same detail) adds to its count.
CREATE TABLE trigger_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  verdict TEXT NOT NULL CHECK (verdict IN ('fired', 'dedup', 'precheck', 'budget', 'paused', 'disabled', 'throttle',
    'queue_full', 'unauthorized', 'too_large', 'bad_payload', 'resolved', 'missed', 'error')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 256),
  task_id TEXT,
  dedup_key TEXT CHECK (dedup_key IS NULL OR length(dedup_key) = 64),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL CHECK (last_at >= first_at)
) STRICT;

CREATE INDEX trigger_fires_trigger ON trigger_fires(trigger_id, id);
CREATE INDEX trigger_fires_dedup ON trigger_fires(trigger_id, dedup_key, last_at) WHERE dedup_key IS NOT NULL;

-- Entries of a feed already turned into a task (or skipped at the first poll): sha256 of the entry's id, link or title.
CREATE TABLE feed_seen (
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  entry TEXT NOT NULL CHECK (length(entry) = 64),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, entry)
) STRICT, WITHOUT ROWID;
