import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOpLock } from "../ops/op-lock.ts";
import { harness, type Ctl, type Harness } from "../testing/apply-harness.ts";
import { addRow, afterUpdate, migrateDb, runCommand, seamsFor } from "../testing/update-ops.ts";
import type { OpSeams } from "./operation.ts";
import { pendingPath, readPending, writePending, type Pending } from "./pending.ts";
import { makeRecoverCommand } from "./recover-command.ts";
import { readCurrent, switchCurrent } from "./releases.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const NEVER = { kind: "never" } as const;
const pairs = (calls: string[]): boolean =>
  calls.every((call, i) => call !== "restart" || calls[i - 1] === "reset-failed");

interface Options {
  step?: Pending["step"];
  migrated?: boolean;
  snapshot?: "present" | "missing" | "none";
  ctl?: Partial<Ctl>;
}

/** An update cut in half: current = new, the journal says how far it got. */
function interrupted(options: Options = {}) {
  h = harness({ ctl: options.ctl ?? {} });
  const name = afterUpdate(h);
  if (options.migrated === true) migrateDb(h);
  if (options.snapshot === "missing") rmSync(join(h.home, "backups", name));
  writePending(h.home, {
    format: 1,
    from: "old",
    to: "new",
    step: options.step ?? "started",
    snapshot: options.snapshot === "none" ? null : name,
    schemaBefore: ["001"],
    startedAt: "2026-10-17T09:59:00.000Z",
  });
  return h;
}
function recoverWith(env: Harness, args: string[] = [], overrides: Partial<OpSeams> = {}) {
  const { seams, seen } = seamsFor(env, overrides);
  return { run: () => runCommand(makeRecoverCommand(seams), ["--app-root", env.app, ...args]), seen };
}

describe("no journal, a damaged journal", () => {
  it("absent: nothing to recover, exit 0, no systemd call", async () => {
    h = harness();
    const result = await recoverWith(h).run();
    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to recover");
    expect(h.calls).toEqual([]);
  });

  it("damaged: the path is printed, exit 1, the file is kept, no systemd call", async () => {
    h = harness();
    mkdirSync(join(h.home, "update"), { recursive: true });
    writeFileSync(pendingPath(h.home), "{broken");
    const result = await recoverWith(h).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain(pendingPath(h.home));
    expect(result.err).toContain("systemctl --user status pap.service");
    expect(result.err).toContain("pap doctor");
    expect(existsSync(pendingPath(h.home))).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe("a valid journal", () => {
  it("snapshot present and a migration ran: the database is restored, current goes back, the journal is cleared", async () => {
    const env = interrupted({ migrated: true });
    const result = await recoverWith(env).run();
    expect(result.code, result.err).toBe(0);
    expect(env.ids()).toEqual(["001"]);
    expect(env.rows()).toEqual(["a"]);
    expect(readCurrent(env.app)).toBe("old");
    expect(readPending(env.home)).toBeNull();
    expect(result.out).toContain("recovered: old is current again");
    expect(result.out).toContain("writes made since 2026-10-17T09:59:00.000Z were discarded");
    expect(env.calls).toEqual(["stop", "reset-failed", "restart"]);
    expect(pairs(env.calls)).toBe(true);
  });

  it("step stopping: no migration ran, so nothing is restored and the old release restarts", async () => {
    const env = interrupted({ step: "stopping" });
    switchCurrent(env.app, "old"); // the cut came before the switch
    addRow(env, "w"); // no migration: a restore would lose this row
    const result = await recoverWith(env).run();
    expect(result.code, result.err).toBe(0);
    expect(env.rows()).toEqual(["a", "w"]);
    expect(readCurrent(env.app)).toBe("old");
    expect(result.out).toContain("the database was not changed");
    expect(readPending(env.home)).toBeNull();
  });

  it("snapshot file missing after a migration: plain recover exits 5 with `database` and the way out", async () => {
    const env = interrupted({ migrated: true, snapshot: "missing" });
    const result = await recoverWith(env).run();
    expect(result.code).toBe(5);
    expect(result.err).toContain("database");
    expect(result.err).toContain("pap update recover --keep-database");
    expect(result.err).toContain("pap restore");
    expect(env.ids()).toEqual(["001", "002"]);
    expect(readPending(env.home)).not.toBeNull();
    expect(readCurrent(env.app)).toBe("new");
  });

  it("the same, with --keep-database: exit 0, the database is never touched, the read-only note is printed", async () => {
    const env = interrupted({ migrated: true, snapshot: "missing" });
    const result = await recoverWith(env, ["--keep-database"]).run();
    expect(result.code, result.err).toBe(0);
    expect(env.ids()).toEqual(["001", "002"]);
    expect(env.rows()).toEqual(["a", "m"]);
    expect(readCurrent(env.app)).toBe("old");
    expect(readPending(env.home)).toBeNull();
    expect(result.out).toContain("the database was kept");
    expect(result.out).toContain("read-only until you update again");
  });

  it("--keep-database with a good snapshot still keeps the migrated database", async () => {
    const env = interrupted({ migrated: true });
    const result = await recoverWith(env, ["--keep-database"]).run();
    expect(result.code, result.err).toBe(0);
    expect(env.rows()).toEqual(["a", "m"]);
  });

  it("a rollback that fails: exit 5 and pending.json is kept", async () => {
    const env = interrupted({ ctl: { listening: [NEVER] } });
    const result = await recoverWith(env).run();
    expect(result.code).toBe(5);
    expect(result.err).toContain("pap update recover");
    expect(result.err).toContain("old_release_not_listening");
    expect(readPending(env.home)).toMatchObject({ step: "rolling_back" });
  });

  it("names the other unit in the failure commands", async () => {
    const env = interrupted({ ctl: { listening: [NEVER] } });
    const result = await recoverWith(env, ["--unit", "pap-preview.service"]).run();
    expect(result.err).toContain("pap update recover --unit pap-preview.service");
  });
});

describe("usage, guard, lock", () => {
  it("--help prints one line", async () => {
    h = harness();
    const result = await recoverWith(h, ["--help"]).run();
    expect(result.code).toBe(0);
    expect(result.out).toContain("pap update recover");
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
  });

  it("an argument is a usage error", async () => {
    h = harness();
    expect((await recoverWith(h, ["extra"]).run()).err).toContain("UsageError");
  });

  it("inside the unit: refused with zero systemd calls, the journal untouched", async () => {
    const env = interrupted();
    const result = await recoverWith(env, [], { readCgroup: () => "0::/app.slice/pap.service\n" }).run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("run this from an SSH or console shell");
    expect(env.calls).toEqual([]);
    expect(readPending(env.home)).toMatchObject({ step: "started" });
  });

  it("an ancestor that is the daemon is refused too", async () => {
    const env = interrupted();
    writeFileSync(join(env.home, "pap.lock"), "4242 99\n");
    const result = await recoverWith(env, [], { ancestors: () => [7, 4242] }).run();
    expect(result.code).toBe(1);
    expect(env.calls).toEqual([]);
  });

  it("a busy update/op.lock refuses with no systemd call", async () => {
    const env = interrupted();
    const release = acquireOpLock(env.home);
    try {
      const result = await recoverWith(env).run();
      expect(result.code).toBe(1);
      expect(result.err).toContain("another pap update, rollback, recover or restore is running");
      expect(env.calls).toEqual([]);
    } finally {
      release();
    }
  });

  it("the lock is released after recovery", async () => {
    const env = interrupted();
    await recoverWith(env).run();
    expect(existsSync(join(env.home, "update", "op.lock"))).toBe(false);
  });
});
