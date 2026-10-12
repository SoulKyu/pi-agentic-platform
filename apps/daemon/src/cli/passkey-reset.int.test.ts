import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { type Db, openDatabase } from "../kernel/db/database.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { createOwnerFromCli, createAuthTestHarness } from "../modules/auth/index.ts";
import { startTestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";
import { pap } from "./testing/pap.ts";

const OLD = "correct horse battery staple";
const NEW = "a brand new long password";
let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
const keyPath = () => join(home, "secrets", "device.key");

const count = (db: Db, table: string) => db.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)?.c;
const counts = (db: Db) => [count(db, "passkeys"), count(db, "auth_sessions"), count(db, "api_tokens")];
function readHome<T>(fn: (db: Db) => T): T {
  const db = openDatabase(join(home, "state.db"), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function seed(): Promise<void> {
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(home, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  try {
    const clock = createFakeClock(1_000_000);
    await createOwnerFromCli(db, clock, { append() {} }, { username: "owner", password: OLD });
    const user = db.get<{ id: string }>("SELECT id FROM users")?.id ?? "";
    for (const id of ["c1", "c2"])
      db.run(
        "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($id, $user, x'00', 0, '[]', 1)",
        { id, user },
      );
    for (let i = 0; i < 3; i++)
      db.run(
        "INSERT INTO auth_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ($h, $user, 1, 1, $exp, $p)",
        { h: `hash${i}`, user, exp: i === 2 ? 5 : 9_999_999_999_999, p: `pub${i}` },
      );
    for (let i = 0; i < 2; i++)
      db.run(
        "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at) VALUES ($id, $user, 't', 'abcd', $hash, '[]', 1, 9999999999999)",
        { id: `tok${i}`, user, hash: String(i).repeat(64) },
      );
  } finally {
    db.close();
  }
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath(), randomBytes(32), { mode: 0o600 });
}

async function passwordWorks(password: string): Promise<boolean> {
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(home, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  try {
    const clock = createFakeClock(5_000_000);
    const { service } = createAuthTestHarness({ db, clock, audit: { append() {} } });
    await service.login({ username: "owner", password, ip: "10.0.0.1", userAgent: undefined });
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-cli-reset-"));
  home = join(scratch, "home");
  mkdirSync(home);
  env = { PATH: process.env.PATH, PAP_HOME: home, HOME: join(scratch, "user") };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("pap passkey reset (the real entry point)", () => {
  it("--keep-password signs everything out, keeps the tokens and the password, forgets the device key", async () => {
    await seed();
    const done = pap(["passkey", "reset", "--keep-password"], env);
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(done.stdout).toBe("removed 2 passkeys, 3 browser sessions; password kept\n");
    expect(readHome(counts)).toEqual([0, 0, 2]);
    expect(existsSync(keyPath())).toBe(false);
    const rows = readHome((db) =>
      db.all<{ actor: string; kind: string; reason: string; detail: string }>(
        "SELECT actor, kind, reason, detail FROM audit WHERE reason = 'credentials_reset'",
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "cli", kind: "auth", reason: "credentials_reset" });
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({
      passkeys: 2,
      sessions: 3,
      tokens: 0,
      passwordChanged: false,
    });
    expect(await passwordWorks(OLD)).toBe(true);
  });

  it("--revoke-tokens with a new password from standard input removes the tokens and changes the password", async () => {
    await seed();
    const done = pap(["passkey", "reset", "--revoke-tokens", "--password-stdin"], env, `${NEW}\n`);
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(done.stdout).toBe("removed 2 passkeys, 3 browser sessions, 2 tokens; password changed\n");
    expect(done.stdout + done.stderr).not.toContain(NEW);
    expect(readHome(counts)).toEqual([0, 0, 0]);
    expect(await passwordWorks(NEW)).toBe(true);
    expect(await passwordWorks(OLD)).toBe(false);
    const detail = readHome((db) =>
      db.get<{ detail: string }>("SELECT detail FROM audit WHERE reason = 'credentials_reset'"),
    );
    expect(detail?.detail).not.toContain(NEW);
    expect(JSON.parse(detail?.detail ?? "")).toMatchObject({ tokens: 2, passwordChanged: true });
  });

  it("changes nothing when the new password is too short", async () => {
    await seed();
    const done = pap(["passkey", "reset", "--password-stdin"], env, "short\n");
    expect(done.status).toBe(1);
    expect(done.stderr).toBe("pap: the password needs 12 to 1024 characters\n");
    expect(readHome(counts)).toEqual([2, 3, 2]);
    expect(existsSync(keyPath())).toBe(true);
  });

  it("needs an owner", () => {
    const { db } = migrate({
      dbPath: join(home, "state.db"),
      backupsDir: join(home, "backups"),
      sources: MIGRATION_SOURCES,
      clock: createFakeClock(),
      logger: silentLogger,
    });
    db.close();
    const done = pap(["passkey", "reset", "--keep-password"], env);
    expect(done.status).toBe(1);
    expect(done.stderr).toBe("pap: no owner yet: run pap user add first\n");
  });

  it("refuses beside a live daemon of the same home and changes nothing", async () => {
    const t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { home } });
    try {
      const cookie = await t.login();
      const status = () =>
        httpRequest(`${t.base}/auth/status`, { headers: { origin: t.origin, cookie } }).then(
          (reply) => JSON.parse(reply.body) as { authenticated: boolean },
        );
      expect((await status()).authenticated).toBe(true);
      const done = pap(["passkey", "reset", "--keep-password"], env);
      expect(done.status).toBe(1);
      expect(done.stderr).toMatch(/^pap: pap is already running on/);
      expect(done.stderr).toContain("systemctl --user stop pap-preview");
      expect((await status()).authenticated).toBe(true);
      expect(existsSync(keyPath())).toBe(true);
    } finally {
      await t.stop();
    }
  });
});
