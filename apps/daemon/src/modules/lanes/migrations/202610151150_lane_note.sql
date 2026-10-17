-- The lane's one-line status an agent writes with `lane_note` (M11 `lane.note`). Model text: shown as text, never markup.
ALTER TABLE lanes ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 2000);
ALTER TABLE lanes ADD COLUMN note_at INTEGER;
