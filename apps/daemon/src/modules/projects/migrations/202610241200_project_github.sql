-- Boxes B2 (lot B, task B3): a box project linked to a GitHub repository. The github module reads and writes it.
-- `owner_id` lets the daily sweep reach the owner's token after the project row is gone; `linked = 0` marks a project
-- that was unlinked or deleted while its signing key could not be removed from GitHub yet (key_state `failed`).
-- clone_state: NULL for a link (nothing to clone), `pending` for a project made from GitHub, then `done` or `failed`.
CREATE TABLE project_github (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  upstream TEXT,
  fork INTEGER NOT NULL DEFAULT 0,
  linked INTEGER NOT NULL DEFAULT 1,
  key_id INTEGER,
  key_state TEXT NOT NULL DEFAULT 'absent' CHECK (key_state IN ('absent', 'added', 'removing', 'failed')),
  clone_state TEXT CHECK (clone_state IN ('pending', 'done', 'failed')),
  clone_error TEXT
) STRICT;
