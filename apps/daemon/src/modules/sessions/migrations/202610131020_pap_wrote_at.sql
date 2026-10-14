-- When pap last wrote a session's Pi file (a worker ended on it, or a fork or clone made it) and how long the file was
-- then. M7 uses them to tell tool results added outside pap from pap's own writes across a restart (decision 75 Q5).
-- NULL for a session that existed before: nothing is known, and nothing is guessed. Not backfilled from `updated_at`,
-- which writes outside pap move too. The stamp sorts after 202610131010 (the migrator refuses one that sorts before an applied one).
ALTER TABLE sessions ADD COLUMN pap_wrote_at INTEGER CHECK (pap_wrote_at IS NULL OR pap_wrote_at >= 0);
ALTER TABLE sessions ADD COLUMN pap_wrote_size INTEGER CHECK (pap_wrote_size IS NULL OR pap_wrote_size >= 0);
