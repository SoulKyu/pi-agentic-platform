-- Connected devices (spec C §4.4): a browser session gets a public id (never its cookie or hash), the address it signed
-- in from (the socket's, R72) and how it signed in.
ALTER TABLE auth_sessions ADD COLUMN public_id TEXT;
UPDATE auth_sessions SET public_id = lower(hex(randomblob(16))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX auth_sessions_public_id ON auth_sessions(public_id);
ALTER TABLE auth_sessions ADD COLUMN ip TEXT CHECK (ip IS NULL OR length(ip) <= 64);
ALTER TABLE auth_sessions ADD COLUMN method TEXT CHECK (method IS NULL OR method IN ('password', 'passkey', 'setup'));
-- The passkey that opened a passkey sign-in (its short id, as `auth.passkeys.list` shows it): removing that passkey signs these out.
ALTER TABLE auth_sessions ADD COLUMN passkey_ref TEXT CHECK (passkey_ref IS NULL OR length(passkey_ref) = 32);
CREATE INDEX auth_sessions_passkey_ref ON auth_sessions(passkey_ref) WHERE passkey_ref IS NOT NULL;
