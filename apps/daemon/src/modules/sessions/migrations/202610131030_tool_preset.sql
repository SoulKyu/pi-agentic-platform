-- A session's tool preset (M7 Task 15, ADR 0028): NULL follows Pi's defaultTools ("configured").
-- Stamped after 202610131020 (Task 3): the migrator refuses a stamp older than one already applied (MC20).
ALTER TABLE sessions ADD COLUMN tool_preset TEXT
  CHECK (tool_preset IS NULL OR tool_preset IN ('none', 'read-only', 'default', 'full', 'chat'));
