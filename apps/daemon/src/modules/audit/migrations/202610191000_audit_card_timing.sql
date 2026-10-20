-- How a card was answered and what a command did (decision 117, A4). All nullable and written once, with the row:
-- the append-only triggers stay as they are, and an older row reads null. `answers` is the offered answers in card order,
-- `asked_at` when the card was sent to the UI, `answered_at` when the answer arrived and `answer` what the owner chose (both null: nobody answered). A result
-- row carries `exit_code` (a shell call's) and `duration_ms` (from the moment the call was allowed to run). Never output.
ALTER TABLE audit ADD COLUMN asked_at INTEGER CHECK (asked_at IS NULL OR asked_at BETWEEN 0 AND 253402300799999);
ALTER TABLE audit ADD COLUMN answers TEXT CHECK (answers IS NULL OR (json_valid(answers) AND length(answers) <= 128));
ALTER TABLE audit ADD COLUMN answered_at INTEGER CHECK (answered_at IS NULL OR answered_at BETWEEN 0 AND 253402300799999);
ALTER TABLE audit ADD COLUMN answer TEXT CHECK (answer IS NULL OR answer IN ('deny', 'once', 'session', 'always', 'host'));
ALTER TABLE audit ADD COLUMN exit_code INTEGER;
ALTER TABLE audit ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0);
