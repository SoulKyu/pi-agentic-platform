-- Pattern "always" rules (M7 Task 2b, ADR 0024): a command prefix for Pi's bash (`pattern` is a JSON array of words), or
-- a whole tool matched with its registered source (`pattern` is {"source":"builtin"|"mcp"}). `grant_key` stays the
-- unique key: for these kinds it is the sha256 of [tool, kind, pattern], computed by the daemon.
ALTER TABLE approval_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'exact' CHECK (kind IN ('exact', 'prefix', 'tool'));
ALTER TABLE approval_rules ADD COLUMN pattern TEXT
  CHECK (pattern IS NULL OR (json_valid(pattern) AND length(pattern) <= 1024));
