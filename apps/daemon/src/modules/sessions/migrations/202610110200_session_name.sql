-- The name Pi keeps in the session file (`session_info`), cached for listings; refreshed from the worker.
-- The stamp sorts after the policy migration (202610110100): the migrator refuses one that sorts before an applied one.
ALTER TABLE sessions ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) <= 256);
