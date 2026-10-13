import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { createFakeClock } from "../kernel/clock.ts";
import type { Db } from "../kernel/db/database.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { createOwnerFromCli, resetCredentials } from "../modules/auth/index.ts";

let scratch: string;
let db: Db;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-reset-rollback-"));
  ({ db } = migrate({
    dbPath: join(scratch, "state.db"),
    backupsDir: join(scratch, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  }));
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("resetCredentials is one transaction with its audit line", () => {
  it("rolls everything back, key file included, when the audit append throws", async () => {
    const clock = createFakeClock(1_000);
    await createOwnerFromCli(
      db,
      clock,
      { append() {} },
      { username: "owner", password: "correct horse battery staple" },
    );
    const user = db.get<{ id: string }>("SELECT id FROM users")?.id ?? "";
    db.run(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ('c1', $user, x'00', 0, '[]', 1)",
      { user },
    );
    db.run(
      "INSERT INTO auth_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('h', $user, 1, 1, 9, 'p')",
      { user },
    );
    mkdirSync(join(scratch, "secrets"));
    writeFileSync(join(scratch, "secrets", "device.key"), "k");
    const before = db.get<{ password_hash: string }>("SELECT password_hash FROM users")?.password_hash;

    const failing = {
      append() {
        throw new Error("audit down");
      },
    };
    await expect(
      resetCredentials(db, failing, scratch, { revokeTokens: true, newPassword: "another long password" }),
    ).rejects.toThrow("audit down");

    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM passkeys")?.c).toBe(1);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM auth_sessions")?.c).toBe(1);
    expect(db.get<{ password_hash: string }>("SELECT password_hash FROM users")?.password_hash).toBe(before);
    expect(existsSync(join(scratch, "secrets", "device.key"))).toBe(true);
  });
});
