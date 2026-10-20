-- The agents a delete moved to the trash (J1b). A VM agent's disk is kept 7 days by pap-vmd (RT-40), and "Purge now" needs
-- the agent's id after the row is gone: the owner's trash entry reads this table. Written by the delete, in the same
-- transaction as the removal; never read for anything but that list.
CREATE TABLE agent_trash (
  agent_id TEXT PRIMARY KEY CHECK (length(agent_id) BETWEEN 6 AND 48),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  deleted_at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_trash_owner ON agent_trash(owner_id, deleted_at);
