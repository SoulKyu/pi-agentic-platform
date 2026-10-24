-- Boxes B1 (decision 124): a project may live in its own microVM. Old rows read as `host`.
-- `deleting` marks a delete in progress: the box is gone or going, the rows follow. One Scratch per owner is the service's rule.
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'host' CHECK (kind IN ('host', 'box'));

CREATE TABLE project_boxes (
  project_id TEXT PRIMARY KEY,
  resources TEXT NOT NULL,
  hosts TEXT NOT NULL,
  scratch INTEGER NOT NULL DEFAULT 0,
  deleting INTEGER NOT NULL DEFAULT 0
) STRICT;
