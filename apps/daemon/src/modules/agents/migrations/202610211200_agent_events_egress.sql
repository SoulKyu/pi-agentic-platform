-- The `egress_refused` card (agents in microVMs, sub-project 2): SQLite cannot alter a CHECK, so the table is rebuilt with
-- the new kind. Ids are kept (the web reads cards by id); nothing references this table.
CREATE TABLE agent_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'task', 'isolated', 'delegation', 'reminder', 'notify', 'egress_refused')),
  task_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND length(data) <= 20000),
  at INTEGER NOT NULL
) STRICT;
INSERT INTO agent_events_new (id, agent_id, owner_id, kind, task_id, data, at)
  SELECT id, agent_id, owner_id, kind, task_id, data, at FROM agent_events;
-- AUTOINCREMENT's high-water mark moves with the table: ids of rows deleted with their agent are not reused.
DELETE FROM sqlite_sequence WHERE name = 'agent_events_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'agent_events_new', seq FROM sqlite_sequence WHERE name = 'agent_events';
DROP TABLE agent_events;
ALTER TABLE agent_events_new RENAME TO agent_events;
CREATE INDEX agent_events_agent ON agent_events(agent_id, at);
