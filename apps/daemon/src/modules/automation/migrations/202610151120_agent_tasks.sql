-- Agent triggers and agent tasks (M11, ADR 0050). NULL `agent_id`: a project trigger or task as in M10 (ADR 0041).
-- `target`: `isolated` (a fresh agent-task session, the home read-only and a scratch folder) or `thread` (a prompt in the
-- agent's thread).
ALTER TABLE triggers ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 6 AND 48);
ALTER TABLE tasks ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 6 AND 48);
ALTER TABLE tasks ADD COLUMN target TEXT
  CHECK ((target IS NULL) = (agent_id IS NULL) AND (target IS NULL OR target IN ('isolated', 'thread')));
-- The agent whose delegation started this task, or the run that set this reminder (depth, M11R80). NULL otherwise.
ALTER TABLE tasks ADD COLUMN requested_by TEXT CHECK (requested_by IS NULL OR (agent_id IS NOT NULL AND requested_by <> agent_id));
-- A reminder or a delayed task: not admitted before this instant.
ALTER TABLE tasks ADD COLUMN not_before INTEGER;
CREATE INDEX triggers_agent ON triggers(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX tasks_agent ON tasks(agent_id, state, created_at) WHERE agent_id IS NOT NULL;
