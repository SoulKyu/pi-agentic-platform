-- An agent's thread serves many tasks, one after the other (M11R71): the session of a thread task is the agent's thread, so
-- the one-task-per-session rule holds for every other task only. Lookups by session keep an index of their own.
DROP INDEX tasks_session;
CREATE UNIQUE INDEX tasks_session_own ON tasks(session_id) WHERE session_id IS NOT NULL AND target IS NOT 'thread';
CREATE INDEX tasks_session_any ON tasks(session_id) WHERE session_id IS NOT NULL;
