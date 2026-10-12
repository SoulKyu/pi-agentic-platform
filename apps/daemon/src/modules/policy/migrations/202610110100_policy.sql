-- "Always" answers to approval cards (spec C §5.3): one row per owner, project and exact call. The grant key is the
-- sha256 of the tool name and the call's exact payload (pap-policy computes it); `label` is what the card showed,
-- cut to 4096 characters, for the list a user revokes from.
CREATE TABLE approval_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project')),
  scope TEXT NOT NULL,
  tool TEXT NOT NULL,
  grant_key TEXT NOT NULL CHECK (length(grant_key) = 64),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, scope_kind, scope, tool, grant_key)
) STRICT;
