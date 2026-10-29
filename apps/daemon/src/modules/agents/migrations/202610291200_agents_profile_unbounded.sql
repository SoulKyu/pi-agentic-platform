-- The agent's role has no length cap any more (decision 142): the profile loses its 32768-character bound. SQLite cannot
-- alter a CHECK, so `agents` is rebuilt. Migrations run in a transaction with foreign keys on, where a rename of `agents`
-- would carry its children's references along and its drop would cascade to them: the children are rebuilt first against
-- `agents_new`, the old tables dropped children first (nothing cascades), and the renames point the references back at
-- `agents`. Ids, rows and agent_events' high-water mark are kept.
CREATE TABLE agents_new (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 48),
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  name_key TEXT NOT NULL CHECK (name_key = lower(name)),
  profile TEXT NOT NULL CHECK (json_valid(profile)),
  thread_session_id TEXT,
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread BETWEEN 0 AND 1000000),
  read_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  quarantined_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (quarantined_at IS NULL OR paused = 1)
) STRICT;
INSERT INTO agents_new (id, owner_id, workspace_id, name, name_key, profile, thread_session_id, unread, read_at, paused,
    quarantined_at, revision, created_at, updated_at)
  SELECT id, owner_id, workspace_id, name, name_key, profile, thread_session_id, unread, read_at, paused, quarantined_at,
    revision, created_at, updated_at FROM agents;

CREATE TABLE agent_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents_new(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'task', 'isolated', 'delegation', 'reminder', 'notify', 'egress_refused')),
  task_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND length(data) <= 20000),
  at INTEGER NOT NULL
) STRICT;
INSERT INTO agent_events_new (id, agent_id, owner_id, kind, task_id, data, at)
  SELECT id, agent_id, owner_id, kind, task_id, data, at FROM agent_events;
DELETE FROM sqlite_sequence WHERE name = 'agent_events_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'agent_events_new', seq FROM sqlite_sequence WHERE name = 'agent_events';

CREATE TABLE agent_requests_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents_new(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approve', 'secret')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 1000),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'answered', 'declined', 'expired', 'cancelled')),
  ref_hash TEXT CHECK (ref_hash IS NULL OR length(ref_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  CHECK ((state = 'pending') = (answered_at IS NULL)),
  CHECK (kind = 'secret' OR ref_hash IS NULL)
) STRICT;
INSERT INTO agent_requests_new (id, agent_id, owner_id, session_id, kind, title, detail, state, ref_hash, created_at,
    expires_at, answered_at)
  SELECT id, agent_id, owner_id, session_id, kind, title, detail, state, ref_hash, created_at, expires_at, answered_at
  FROM agent_requests;

DROP TABLE agent_events;
DROP TABLE agent_requests;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
ALTER TABLE agent_events_new RENAME TO agent_events;
ALTER TABLE agent_requests_new RENAME TO agent_requests;
CREATE UNIQUE INDEX agents_owner_name ON agents(owner_id, name_key);
CREATE UNIQUE INDEX agents_thread ON agents(thread_session_id) WHERE thread_session_id IS NOT NULL;
CREATE INDEX agent_events_agent ON agent_events(agent_id, at);
CREATE INDEX agent_requests_pending ON agent_requests(owner_id, state) WHERE state = 'pending';
