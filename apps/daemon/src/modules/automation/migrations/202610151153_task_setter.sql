-- The session that set a reminder (W5-R44): a tainted reminder may prompt the agent's thread only when the thread session
-- that fires it is the one that set it. NULL for every other task.
ALTER TABLE tasks ADD COLUMN set_by_session TEXT CHECK (set_by_session IS NULL OR length(set_by_session) BETWEEN 1 AND 128);
