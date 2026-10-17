-- Long-term agents (D12, ADR 0050). The profile is the validated `AgentInput` (contracts) as JSON, parsed again at every
-- read: a row that does not parse is `unreadable`, never starts a worker, and can be deleted. The home is
-- $PAP_HOME/agents/<id> (0700); its secrets are in $PAP_HOME/secrets/vault (never here, C §3.1).
CREATE TABLE agents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 48),
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  -- The name the owner and `@Name` use; unique per owner whatever the case.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  name_key TEXT NOT NULL CHECK (name_key = lower(name)),
  profile TEXT NOT NULL CHECK (json_valid(profile) AND length(profile) <= 32768),
  thread_session_id TEXT,
  -- Assistant replies and event cards since the owner last read the thread (the rail badge).
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread BETWEEN 0 AND 1000000),
  read_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  quarantined_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (quarantined_at IS NULL OR paused = 1)
) STRICT;
CREATE UNIQUE INDEX agents_owner_name ON agents(owner_id, name_key);
CREATE UNIQUE INDEX agents_thread ON agents(thread_session_id) WHERE thread_session_id IS NOT NULL;

-- Display-only cards of a thread (decision 29): a schedule or task run, an isolated run's summary, a delegation result,
-- a reminder, a notification the agent sent (board 09's solid "notification" card). Never sent to the model. `data` is
-- validated `AgentEventData`; a summary from an isolated run or a delegation is untrusted text.
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'task', 'isolated', 'delegation', 'reminder', 'notify')),
  task_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND length(data) <= 20000),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_events_agent ON agent_events(agent_id, at);

-- What an agent waits for from the owner (agent.approve, secret.request). The answer to a secret request is never
-- here: the value goes to the vault, or to the worker for one use (ADR 0049). `ref_hash` is sha256 of the one-use ref.
CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
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
CREATE INDEX agent_requests_pending ON agent_requests(owner_id, state) WHERE state = 'pending';
