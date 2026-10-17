-- Who a run counts for (M11): the agent whose session ran it (its daily budget, its status panel), and the parent of a
-- subagent's child (its cost rolls up). Copied from the session's binding when the run starts; never changed.
ALTER TABLE runs ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 6 AND 48);
ALTER TABLE runs ADD COLUMN parent_session_id TEXT CHECK (parent_session_id IS NULL OR length(parent_session_id) <= 128);
CREATE INDEX runs_agent_started ON runs(agent_id, started_at) WHERE agent_id IS NOT NULL;
CREATE INDEX runs_parent ON runs(parent_session_id) WHERE parent_session_id IS NOT NULL;
