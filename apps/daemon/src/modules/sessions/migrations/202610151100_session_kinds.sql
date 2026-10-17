-- Who a session is (M11, ADR 0047): the daemon's own record, read when its worker starts and at every platform call.
-- `parent_session_id`: a subagent's child thread (D11). `agent_id` + `agent_role`: the agent's pinned thread, one of
-- its runs outside the thread (trigger, delegation, review), or the child of its thread (role `child`, which needs a
-- parent; a child of a plain session has no agent). NULL for every other session. `parent_session_id` comes first:
-- `agent_role`'s CHECK reads it.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT
  CHECK (parent_session_id IS NULL OR (length(parent_session_id) BETWEEN 1 AND 128 AND parent_session_id <> id));
ALTER TABLE sessions ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 6 AND 48);
ALTER TABLE sessions ADD COLUMN agent_role TEXT
  CHECK (
    (agent_role IS NULL) = (agent_id IS NULL)
    AND (agent_role IS NULL OR agent_role IN ('thread', 'task', 'child'))
    AND ((agent_role IS 'child') = (agent_id IS NOT NULL AND parent_session_id IS NOT NULL))
  );
CREATE INDEX sessions_agent ON sessions(agent_id, agent_role) WHERE agent_id IS NOT NULL;
CREATE INDEX sessions_parent ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
