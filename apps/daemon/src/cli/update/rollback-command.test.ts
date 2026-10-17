import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOpLock } from "../ops/op-lock.ts";
import { harness, makeRelease, URL_READY, type Ctl, type Harness } from "../testing/apply-harness.ts";
import { afterUpdate, migrateDb, runCommand, seamsFor, writeBuildInfo } from "../testing/update-ops.ts";
import { readPending, writePending } from "./pending.ts";
import { readCurrent } from "./releases.ts";
import { makeRollbackCommand } from "./rollback-command.ts";
import type { OpSeams } from "./operation.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const NEVER = { kind: "never" } as const;
const pairs = (calls: string[]): boolean =>
  calls.every((call, i) => call !== "restart" || calls[i - 1] === "reset-failed");

/** After an update: current = new, a snapshot of the old database; `migrated` adds what the new release wrote. */
function setup(options: { migrated?: boolean; ctl?: Partial<Ctl>; withDb?: boolean } = {}) {
  h = harness({
    ...(options.withDb === undefined ? {} : { withDb: options.withDb }),
    ctl: options.ctl ?? {},
  });
  const snapshot = afterUpdate(h);
  if (options.migrated === true) migrateDb(h);
  return { env: h, snapshot };
}
function rollbackWith(env: Harness, args: string[], overrides: Partial<OpSeams> = {}) {
  const { seams, seen } = seamsFor(env, overrides);
  return { run: () => runCommand(makeRollbackCommand(seams), ["--app-root", env.app, ...args]), seen };
}

describe("usage", () => {
  it("--help prints one line and touches nothing", async () => {
    const { env } = setup();
    const { run, seen } = rollbackWith(env, ["--help"]);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toContain("pap update rollback");
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
    expect(seen.units).toEqual([]);
    expect(env.calls).toEqual([]);
  });

  it("--restore-database with --keep-database is a usage error", async () => {
    const { env } = setup();
    const result = await rollbackWith(env, ["--restore-database", "--keep-database"]).run();
    expect(result.err).toContain("UsageError");
    expect(result.err).toContain("--restore-database or --keep-database");
    expect(env.calls).toEqual([]);
  });

  it("an argument is a usage error", async () => {
    const { env } = setup();
    expect((await rollbackWith(env, ["extra"]).run()).err).toContain("UsageError");
  });
});

describe("refusals before anything changes", () => {
  it("pending.json exists: exit 1, run recover first, no systemd call", async () => {
    const { env } = setup();
    writePending(env.home, {
      format: 1,
      from: "old",
      to: "new",
      step: "started",
      snapshot: null,
      schemaBefore: null,
      startedAt: "2026-10-17T10:00:00.000Z",
    });
    const result = await rollbackWith(env, []).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("pap update recover");
    expect(env.calls).toEqual([]);
    expect(readCurrent(env.app)).toBe("new");
  });

  it("no other complete release: exit 1", async () => {
    h = harness();
    afterUpdate(h);
    rmSync(join(h.app, "releases", "old"), { recursive: true });
    const result = await rollbackWith(h, []).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("no other complete release");
    expect(h.calls).toEqual([]);
  });

  it("--to the current release and --to an unknown one: exit 1", async () => {
    const { env } = setup();
    expect((await rollbackWith(env, ["--to", "new"]).run()).code).toBe(1);
    expect((await rollbackWith(env, ["--to", "ghost"]).run()).code).toBe(1);
    expect(env.calls).toEqual([]);
  });

  it("a migrated database and no flag: exit 1 with both options, their cost and the snapshot's time", async () => {
    const { env } = setup({ migrated: true });
    const result = await rollbackWith(env, []).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("--restore-database");
    expect(result.err).toContain("--keep-database");
    expect(result.err).toContain("2026-10-17T10:00:00.000Z");
    expect(result.err).toContain("writes since then are discarded");
    expect(result.err).toContain("opens the database read-only until you update again");
    expect(env.calls).toEqual([]);
    expect(env.ids()).toEqual(["001", "002"]);
    expect(readPending(env.home)).toBeNull();
    expect(readCurrent(env.app)).toBe("new");
  });

  it("a bad --unit is a usage error", async () => {
    const { env } = setup();
    expect((await rollbackWith(env, ["--unit", "../x"]).run()).code).toBe(64);
  });

  it("no installed unit: exit 1", async () => {
    const { env } = setup();
    const { seams } = seamsFor(env, {}, null);
    const result = await runCommand(makeRollbackCommand(seams), ["--app-root", env.app]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no installed unit");
    expect(env.calls).toEqual([]);
  });
});

describe("the database decision", () => {
  it("--restore-database: the snapshot comes back, current moves, pending is gone, the cost is printed", async () => {
    const { env } = setup({ migrated: true });
    const result = await rollbackWith(env, ["--restore-database"]).run();
    expect(result.code, result.err).toBe(0);
    expect(env.ids()).toEqual(["001"]);
    expect(env.rows()).toEqual(["a"]);
    expect(readCurrent(env.app)).toBe("old");
    expect(readPending(env.home)).toBeNull();
    expect(result.out).toContain("rolled back: new -> old");
    expect(result.out).toContain("writes made since 2026-10-17T10:00:00.000Z were discarded");
  });

  it("--keep-database: no row changes, current moves, the read-only warning is printed", async () => {
    const { env } = setup({ migrated: true });
    const result = await rollbackWith(env, ["--keep-database"]).run();
    expect(result.code, result.err).toBe(0);
    expect(env.ids()).toEqual(["001", "002"]);
    expect(env.rows()).toEqual(["a", "m"]);
    expect(readCurrent(env.app)).toBe("old");
    expect(result.out).toContain("the database was kept");
    expect(result.out).toContain("read-only");
    expect(env.calls).toEqual(["stop", "reset-failed", "restart"]);
  });

  it("no migration to undo: no flag needed, the database is left as is", async () => {
    const { env } = setup();
    const result = await rollbackWith(env, []).run();
    expect(result.code, result.err).toBe(0);
    expect(env.rows()).toEqual(["a"]);
    expect(result.out).toContain("rolled back: new -> old");
    expect(result.out).not.toContain("discarded");
  });

  it("--restore-database with nothing to undo does not claim a restore", async () => {
    const { env } = setup();
    const result = await rollbackWith(env, ["--restore-database"]).run();
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("discarded");
    expect(result.out).toContain("the database was not changed");
  });

  it("no snapshot at all: runs, and says the older release may open the database read-only", async () => {
    const { env, snapshot } = setup({ migrated: true });
    rmSync(join(env.home, "backups", snapshot));
    const result = await rollbackWith(env, []).run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("no snapshot: the older release may open the database read-only");
    expect(env.ids()).toEqual(["001", "002"]);
  });
});

describe("the transaction", () => {
  it("reset-failed precedes every restart (M6bR15)", async () => {
    const { env } = setup();
    await rollbackWith(env, []).run();
    expect(env.calls).toEqual(["stop", "reset-failed", "restart"]);
    expect(pairs(env.calls)).toBe(true);
  });

  it("--to picks that release; the default is the newest other", async () => {
    h = harness();
    makeRelease(h.app, "mid");
    writeBuildInfo(h, "mid", "2026-10-01T00:00:00.000Z");
    afterUpdate(h);
    expect((await rollbackWith(h, []).run()).code).toBe(0);
    expect(readCurrent(h.app)).toBe("mid");
  });

  it("an old release that never listens: exit 5, pending.json kept and the way out printed", async () => {
    const { env } = setup({ ctl: { listening: [NEVER] } });
    const result = await rollbackWith(env, []).run();
    expect(result.code).toBe(5);
    expect(result.err).toContain("pap update recover");
    expect(result.err).toContain("systemctl --user status pap.service");
    expect(readPending(env.home)).toMatchObject({ step: "rolling_back", from: "old", to: "new" });
  });

  it("another unit's name appears in the failure commands", async () => {
    const { env } = setup({ ctl: { listening: [NEVER] } });
    const result = await rollbackWith(env, ["--unit", "pap-preview.service"]).run();
    expect(result.code).toBe(5);
    expect(result.err).toContain("pap update recover --unit pap-preview.service");
  });

  it("success leaves no op.lock behind", async () => {
    const { env } = setup({ ctl: { listening: [URL_READY] } });
    await rollbackWith(env, []).run();
    expect(existsSync(join(env.home, "update", "op.lock"))).toBe(false);
    expect(readdirSync(join(env.home, "update"))).toEqual([]);
  });
});

describe("the database flags without a usable snapshot", () => {
  it("--restore-database says plainly that no restore happened", async () => {
    const { env, snapshot } = setup({ migrated: true });
    rmSync(join(env.home, "backups", snapshot));
    const result = await rollbackWith(env, ["--restore-database"]).run();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(
      "--restore-database: there is no usable snapshot, so the database was NOT restored",
    );
    expect(env.ids()).toEqual(["001", "002"]);
  });
});

describe("guard and lock (M6bR51, M6bR52)", () => {
  it("an ancestor that is the daemon is refused too, with zero systemd calls", async () => {
    const { env } = setup();
    writeFileSync(join(env.home, "pap.lock"), "4242 99\n");
    const result = await rollbackWith(env, [], { ancestors: () => [7, 4242] }).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("run this from an SSH or console shell");
    expect(env.calls).toEqual([]);
  });

  const SENTENCE = "run this from an SSH or console shell: stopping pap would end this terminal";

  it("inside the unit's cgroup: refused with zero systemd calls and nothing written", async () => {
    const { env } = setup();
    const result = await rollbackWith(env, [], {
      readCgroup: () => "0::/user.slice/user@1000.service/app.slice/pap.service\n",
    }).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain(SENTENCE);
    expect(env.calls).toEqual([]);
    expect(existsSync(join(env.home, "update"))).toBe(false);
  });

  it("a busy update/op.lock refuses with no systemd call", async () => {
    const { env } = setup();
    const release = acquireOpLock(env.home);
    try {
      const result = await rollbackWith(env, []).run();
      expect(result.code).toBe(1);
      expect(result.err).toContain("another pap update, rollback, recover or restore is running");
      expect(env.calls).toEqual([]);
    } finally {
      release();
    }
  });
});
