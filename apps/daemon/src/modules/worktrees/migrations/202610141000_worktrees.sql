-- M9 (D03): the worktrees pap creates under $PAP_HOME/worktrees, in two phases (ADR 0033). A row is written before git
-- touches anything ('creating'), made 'ready' once the worktree is checked out and unlocked, and 'removing' before it is
-- removed; the boot finishes or undoes whatever a crash left in 'creating' or 'removing'.
CREATE TABLE worktrees (
  path TEXT PRIMARY KEY CHECK (length(path) BETWEEN 2 AND 4096 AND substr(path, 1, 1) = '/'),
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  repo_root TEXT NOT NULL CHECK (length(repo_root) BETWEEN 2 AND 4096 AND substr(repo_root, 1, 1) = '/'),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 200),
  -- The admin dir git created (<common>/worktrees/<name>, the name may carry a counter), read back and checked after `worktree add`.
  git_dir TEXT CHECK (git_dir IS NULL OR (length(git_dir) BETWEEN 2 AND 4096 AND substr(git_dir, 1, 1) = '/')),
  base_oid TEXT NOT NULL CHECK (length(base_oid) IN (40, 64)),
  created_branch INTEGER NOT NULL CHECK (created_branch IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'removing')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX worktrees_owner ON worktrees (owner_id, state);
