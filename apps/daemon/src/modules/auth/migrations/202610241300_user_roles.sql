ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'));
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN budget_usd REAL;
UPDATE users SET role = 'owner' WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1);
CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';
