import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { openDatabase } from "../kernel/db/database.ts";
import { acquireInstanceLock } from "../kernel/home.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { createAuditModule } from "../modules/audit/index.ts";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const pap = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN, ...args],
    { env, encoding: "utf8", timeout: 30_000 },
  );

const now = new Date();
const thisMonth = now.toISOString().slice(0, 7);
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  .toISOString()
  .slice(0, 7);

let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-cli-prune-"));
  home = join(scratch, "home");
  env = { PATH: process.env.PATH, PAP_HOME: home, HOME: join(scratch, "user") };
  mkdirSync(home);
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(home, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  const append = (at: number, count: number) => {
    const { port } = createAuditModule({ db, clock: createFakeClock(at), logger: silentLogger });
    for (let i = 0; i < count; i++)
      port.append({ ownerId: null, actor: "system", kind: "audit", reason: `row ${i}` });
  };
  append(Date.UTC(2024, 4, 10), 3);
  append(Date.UTC(2024, 5, 10), 2);
  append(Date.now(), 1);
  db.close();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function rowsByMonth(): Record<string, number> {
  const db = openDatabase(join(home, "state.db"), { readOnly: true });
  try {
    const rows = db.all<{ month: string; n: number }>(
      "SELECT month, COUNT(*) AS n FROM audit GROUP BY month ORDER BY month",
    );
    return Object.fromEntries(rows.map((r) => [r.month, r.n]));
  } finally {
    db.close();
  }
}

describe("pap audit prune (the real entry point)", () => {
  it("prunes every month older than 12 months, then finds nothing to prune", () => {
    const first = pap(["audit", "prune"], env);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe("pruned 2024-05: 3 rows\npruned 2024-06: 2 rows\n");
    expect(rowsByMonth()).toEqual({ [thisMonth]: 3 }); // the recent row and the two prune lines
    const second = pap(["audit", "prune"], env);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("nothing to prune\n");
  });

  it("prunes one month on request", () => {
    const one = pap(["audit", "prune", "--month", "2024-06"], env);
    expect(one.stdout).toBe("pruned 2024-06: 2 rows\n");
    expect(rowsByMonth()).toEqual({ "2024-05": 3, [thisMonth]: 2 });
  });

  it("counts without deleting on a dry run, and refuses a month inside the retention", () => {
    expect(pap(["audit", "prune", "--dry-run"], env).stdout).toBe(
      "would prune 2024-05: 3 rows\nwould prune 2024-06: 2 rows\n",
    );
    expect(rowsByMonth()["2024-05"]).toBe(3);
    const refused = pap(["audit", "prune", "--month", lastMonth], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(`pap: ${lastMonth} is within the 12-month retention\n`);
  });

  it("refuses to run beside a live daemon and touches nothing", () => {
    const lock = acquireInstanceLock(home); // held by this test process, which is alive
    try {
      const refused = pap(["audit", "prune"], env);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(
        /^pap: pap is already running on .*\npap: for the preview service: systemctl --user stop pap-preview\n$/s,
      );
      expect(rowsByMonth()["2024-05"]).toBe(3);
    } finally {
      lock.release();
    }
  });

  it("refuses a home without data and creates nothing", () => {
    const empty = join(scratch, "empty");
    const refused = pap(["audit", "prune"], { ...env, PAP_HOME: empty });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(`pap: no pap data in ${empty}\n`);
  });
});
