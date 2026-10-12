-- D02 (M4): a project is the git root of its sessions' folder, or that folder outside git (the scope of "always" rules).
-- Made the first time a session needs it; the person names and orders them. Positions are fractional: a move writes one row.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  root TEXT NOT NULL CHECK (length(root) BETWEEN 1 AND 4096),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, root)
) STRICT;

CREATE INDEX projects_owner ON projects(owner_id, position);
