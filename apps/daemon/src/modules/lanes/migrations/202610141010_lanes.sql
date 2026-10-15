-- M9 (D03, D22): lanes, their fan-out groups, review state and approved project scripts (ADR 0033, 0034).
CREATE TABLE lanes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 53),
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  -- Who asked for the lane: a token-created lane never runs its setup by itself (M9R110, agreement 5).
  created_by TEXT NOT NULL CHECK (created_by IN ('session', 'token')),
  project_root TEXT NOT NULL CHECK (length(project_root) BETWEEN 2 AND 4096 AND substr(project_root, 1, 1) = '/'),
  worktree TEXT NOT NULL UNIQUE CHECK (length(worktree) BETWEEN 2 AND 4096 AND substr(worktree, 1, 1) = '/'),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 200),
  base_ref TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  base_oid TEXT NOT NULL CHECK (length(base_oid) IN (40, 64)),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) <= 20000),
  source TEXT CHECK (source IS NULL OR (json_valid(source) AND length(source) <= 4096)),
  model TEXT CHECK (model IS NULL OR (json_valid(model) AND length(model) <= 1024)),
  primary_session_id TEXT CHECK (primary_session_id IS NULL OR length(primary_session_id) <= 128),
  fanout_id TEXT REFERENCES lane_fanouts (id),
  fanout_slot INTEGER CHECK (fanout_slot IS NULL OR fanout_slot BETWEEN 0 AND 3),
  setup_state TEXT NOT NULL DEFAULT 'none'
    CHECK (setup_state IN ('none', 'queued', 'pending', 'running', 'ok', 'failed', 'interrupted', 'unapproved')),
  setup_exit INTEGER,
  setup_started_at INTEGER,
  setup_finished_at INTEGER,
  test_state TEXT NOT NULL DEFAULT 'none'
    CHECK (test_state IN ('none', 'queued', 'running', 'passed', 'failed', 'interrupted', 'unapproved')),
  test_exit INTEGER,
  test_finished_at INTEGER,
  -- The running script's process group and `<boot id>:<start time>`, so a boot after a crash kills an orphan (M9-RT-13).
  script_pgid INTEGER CHECK (script_pgid IS NULL OR script_pgid > 1),
  script_proc TEXT CHECK (script_proc IS NULL OR length(script_proc) <= 128),
  pr_number INTEGER CHECK (pr_number IS NULL OR pr_number > 0),
  pr_url TEXT CHECK (pr_url IS NULL OR length(pr_url) <= 2048),
  first_run_ended_at INTEGER,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'active', 'archiving', 'archived', 'failed')),
  failed_reason TEXT CHECK (failed_reason IS NULL OR failed_reason IN ('git', 'prepare', 'disk', 'interrupted')),
  archived_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX lanes_owner ON lanes (owner_id, state, created_at);

CREATE TABLE lane_fanouts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id TEXT NOT NULL,
  -- The rendered first prompt (an issue's fenced text included, M9-RT-14): at most 24 000 characters.
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 24000),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE lane_reviews (
  lane_id TEXT PRIMARY KEY REFERENCES lanes (id),
  owner_id TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc) AND length(doc) <= 1048576),
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

-- One approved text per owner, project and kind: a new approval replaces the row, so the old text is what "changed
-- since you approved it" compares with (decision 30).
CREATE TABLE lane_script_approvals (
  owner_id TEXT NOT NULL,
  project_root TEXT NOT NULL CHECK (length(project_root) BETWEEN 2 AND 4096),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'archive', 'test')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  script TEXT NOT NULL CHECK (length(script) BETWEEN 1 AND 16384),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, project_root, kind)
) STRICT;
