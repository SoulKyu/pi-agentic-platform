-- When a passkey last signed someone in (written with its counter), so the list shows which keys still work.
ALTER TABLE passkeys ADD COLUMN last_used_at INTEGER;
