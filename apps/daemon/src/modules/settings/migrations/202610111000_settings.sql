-- Account-scope settings (DESIGN.md §13): one JSON document per owner and key, validated against the contracts schema
-- before it is written. Device-scope settings (density, sizes, motion, chat width) never reach the server.
CREATE TABLE settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
) STRICT;
