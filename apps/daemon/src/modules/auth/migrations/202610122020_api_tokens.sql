-- API tokens (spec C §4.4): `pap_` + 43 base64url characters, shown once; only the sha256 of the value is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  hint TEXT NOT NULL CHECK (length(hint) = 4),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  permissions TEXT NOT NULL CHECK (json_valid(permissions)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX api_tokens_user ON api_tokens(user_id);
