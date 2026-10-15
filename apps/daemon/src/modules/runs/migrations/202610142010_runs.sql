-- The runs registry (spec C §3.4, D16, ADR 0043): one row per run of any session, kept without limit and exported to
-- logs/runs.jsonl when the run ends. Never a prompt, a payload, a path or a tool argument: ids, counts and money only.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  task_id TEXT,
  -- user, extension, trigger, manual, retry, resume in M10; M11 adds its own (agent threads, delegations), hence no closed list here.
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 32),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted', 'limited')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  provider TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 64),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),
  billing TEXT NOT NULL DEFAULT 'unknown' CHECK (billing IN ('api', 'subscription', 'unknown')),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  -- Pi's own price of the tokens (usage.cost.total, compaction included): the provider's cost for an API key, the
  -- API-equivalent for a subscription.
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  -- Why pap or the provider ended it: `deadline`, `run_budget` and `budget` are the runner's aborts (`markEnding`).
  error_class TEXT CHECK (error_class IS NULL OR error_class IN ('provider', 'usage_limit', 'aborted', 'crash', 'deadline',
    'run_budget', 'budget')),
  limit_reset_at INTEGER,
  CHECK ((status = 'running') = (ended_at IS NULL)),
  CHECK (limit_reset_at IS NULL OR status = 'limited')
) STRICT;

CREATE INDEX runs_owner_started ON runs(owner_id, started_at);
CREATE INDEX runs_session ON runs(session_id, started_at);
CREATE INDEX runs_task ON runs(task_id) WHERE task_id IS NOT NULL;
