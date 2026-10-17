-- The owner's own tool choice on an agent thread (M11, W5-R28), kept apart from the profile's preset: NULL until the owner
-- sets one with `sessions.setTools`. At every start the thread runs with the narrower of this and the start-time profile's
-- preset; a relaunch never overwrites it. `tool_preset` stays the preset in force. `configured` is Pi's default tools.
-- Stamped after lane B's 202610151150 and before M11b's 202610151155.
ALTER TABLE sessions ADD COLUMN owner_preset TEXT
  CHECK (owner_preset IS NULL OR owner_preset IN ('configured', 'none', 'read-only', 'default', 'full', 'chat'));
