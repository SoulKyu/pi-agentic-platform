import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "../sessions/index.ts";
import { POLICY_MIGRATIONS } from "./index.ts";
import { createSessionPolicyStore } from "./session-store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-policy-migrate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (sources: Parameters<typeof migrate>[0]["sources"]) =>
  migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources,
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;

/** The policy migrations main already holds (M2): the home as M4 left it, before the session policy table exists. */
function homeBeforeM5() {
  const old = join(dir, "policy-before-m5");
  mkdirSync(old);
  copyFileSync(join(POLICY_MIGRATIONS.dir, "202610110100_policy.sql"), join(old, "202610110100_policy.sql"));
  return open([KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, { module: POLICY_MIGRATIONS.module, dir: old }]);
}
const insertSession = (db: ReturnType<typeof open>, id: string, ownerId: string) =>
  db.run(
    "INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, created_at, updated_at) VALUES ($id, NULL, NULL, '/w', $ownerId, NULL, 1, 1)",
    { id, ownerId },
  );

describe("the session policy migration (M5, ADR 0020)", () => {
  it("reads every session that exists when it runs as tainted, whoever owns it", () => {
    const before = homeBeforeM5();
    insertSession(before, "old1", "u1");
    insertSession(before, "old2", "u2");
    before.close();
    const db = open([KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS]);
    const store = createSessionPolicyStore(db);
    for (const [id, owner] of [
      ["old1", "u1"],
      ["old2", "u2"],
    ] as const) {
      const row = store.get(owner, id);
      expect(row?.taintedAt, id).toEqual(expect.any(Number));
      expect(row).toMatchObject({ approvalMode: null, taintEpoch: 0 });
    }
    expect(store.get("u2", "old1")).toBeUndefined();
    db.close();
  });

  it("leaves a session created after the migration untainted", () => {
    const before = homeBeforeM5();
    insertSession(before, "old1", "u1");
    before.close();
    const db = open([KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS]);
    insertSession(db, "new1", "u1");
    const store = createSessionPolicyStore(db);
    expect(store.get("u1", "new1")).toBeUndefined();
    expect(store.get("u1", "old1")?.taintedAt).toEqual(expect.any(Number));
    db.close();
  });

  it("starts an empty home with no row at all", () => {
    const db = open([KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS]);
    expect(db.get("SELECT COUNT(*) AS n FROM session_policy")).toEqual({ n: 0 });
    db.close();
  });
});
