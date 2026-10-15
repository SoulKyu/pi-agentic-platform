import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "../sessions/index.ts";
import { POLICY_MIGRATIONS } from "./index.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-policy-allowlist-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  db.run(
    "INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, created_at, updated_at) VALUES ('s1', NULL, NULL, '/w', 'u1', NULL, 1, 1)",
  );
  db.run(
    "INSERT INTO session_policy (session_id, owner_id, tainted_at, updated_at) VALUES ('s1', 'u1', 5, 5)",
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const set = (sql: string) => () => db.run(`UPDATE session_policy SET ${sql} WHERE session_id = 's1'`);
const row = () =>
  db.get<{ list: string | null; unattended: number; taintedAt: number | null }>(
    "SELECT tool_allowlist AS list, unattended, tainted_at AS taintedAt FROM session_policy WHERE session_id = 's1'",
  );

describe("the tool allowlist migration (M10R30)", () => {
  it("reads an existing row with no list, attended and still tainted", () => {
    expect(row()).toEqual({ list: null, unattended: 0, taintedAt: 5 });
  });

  it("refuses a list that is not a JSON array, and an unattended flag outside 0 and 1", () => {
    expect(set(`tool_allowlist = '{"a":1}'`)).toThrow();
    expect(set(`tool_allowlist = 'not json'`)).toThrow();
    expect(set(`tool_allowlist = '"read"'`)).toThrow();
    expect(set(`unattended = 2`)).toThrow();
    expect(row()).toEqual({ list: null, unattended: 0, taintedAt: 5 });
  });

  it("refuses unattended without a list, and lifting the list while unattended", () => {
    expect(set(`unattended = 1`)).toThrow();
    set(`tool_allowlist = '["read"]', unattended = 1`)();
    expect(set(`tool_allowlist = NULL`)).toThrow();
    set(`unattended = 0`)();
    set(`tool_allowlist = NULL`)();
    expect(row()).toEqual({ list: null, unattended: 0, taintedAt: 5 });
  });

  it("goes with the session row", () => {
    set(`tool_allowlist = '["read"]'`)();
    db.run("DELETE FROM sessions WHERE id = 's1'");
    expect(db.get("SELECT COUNT(*) AS n FROM session_policy")).toEqual({ n: 0 });
  });
});
