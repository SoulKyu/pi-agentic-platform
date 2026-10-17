-- Agent items in the Inbox (decision 29, M11). `ref_id`: the request, staged memory fact or agent the item is about;
-- one row per (ref_id, kind), reopened rather than added. `entry_id`: where the thread opens. `detail`: one short line
-- the agent or a memory fact wrote, shown as untrusted text.
ALTER TABLE inbox_items ADD COLUMN agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 6 AND 48);
ALTER TABLE inbox_items ADD COLUMN ref_id TEXT CHECK (ref_id IS NULL OR length(ref_id) BETWEEN 1 AND 128);
ALTER TABLE inbox_items ADD COLUMN entry_id TEXT CHECK (entry_id IS NULL OR length(entry_id) <= 128);
ALTER TABLE inbox_items ADD COLUMN detail TEXT CHECK (detail IS NULL OR length(detail) <= 500);
CREATE UNIQUE INDEX inbox_ref_kind ON inbox_items(ref_id, kind) WHERE ref_id IS NOT NULL;
CREATE INDEX inbox_agent ON inbox_items(agent_id, created_at) WHERE agent_id IS NOT NULL;
