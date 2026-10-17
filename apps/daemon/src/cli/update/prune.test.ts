import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingPath, writePending } from "./pending.ts";
import { pruneSnapshots } from "./prune.ts";

const prune = (...args: Parameters<typeof pruneSnapshots>): string[] => pruneSnapshots(...args).removed;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-prune-"));
  mkdirSync(join(home, "backups"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A snapshot whose modification time is `day` days after 2026-10-01. */
function snap(name: string, day: number): string {
  const path = join(home, "backups", name);
  writeFileSync(path, "x");
  const at = new Date(Date.UTC(2026, 9, 1 + day));
  utimesSync(path, at, at);
  return name;
}
const left = (): string[] => readdirSync(join(home, "backups")).sort();
const names = (...days: number[]): string[] =>
  days.map((day) => `pre-update-r${day}-2026-10-${String(day + 1).padStart(2, "0")}T00-00-00-000Z.db`);

describe("pruneSnapshots", () => {
  it("keeps the three newest by modification time and removes the older ones", () => {
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    const removed = prune(home);
    expect(removed.sort()).toEqual(names(1, 2).sort());
    expect(left()).toEqual(names(3, 4, 5).sort());
  });

  it("order is the modification time, not the name", () => {
    snap("pre-update-zz-2026-10-01T00-00-00-000Z.db", 1); // sorts last by name, oldest by time
    snap("pre-update-aa-2026-10-01T00-00-00-000Z.db", 2);
    snap("pre-update-bb-2026-10-01T00-00-00-000Z.db", 3);
    snap("pre-update-cc-2026-10-01T00-00-00-000Z.db", 4);
    prune(home);
    expect(left()).not.toContain("pre-update-zz-2026-10-01T00-00-00-000Z.db");
    expect(left()).toHaveLength(3);
  });

  it("three or fewer: nothing is removed", () => {
    for (const [i, name] of names(1, 2, 3).entries()) snap(name, i + 1);
    expect(prune(home)).toEqual([]);
    expect(left()).toHaveLength(3);
  });

  it("never removes the snapshot a live pending.json names, even the oldest", () => {
    const [oldest] = names(1);
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    writePending(home, {
      format: 1,
      from: "a",
      to: "b",
      step: "rolling_back",
      snapshot: oldest as string,
      schemaBefore: ["001"],
      startedAt: "2026-10-17T10:00:00.000Z",
    });
    prune(home);
    expect(left()).toContain(oldest);
    expect(left()).toEqual([oldest, ...names(3, 4, 5)].sort());
  });

  it("a damaged pending.json removes nothing (it may name any snapshot)", () => {
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    mkdirSync(join(home, "update"));
    writeFileSync(pendingPath(home), "{broken");
    expect(prune(home)).toEqual([]);
    expect(left()).toHaveLength(5);
  });

  it("the snapshot of this run is kept whatever its time", () => {
    const [oldest] = names(1);
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    prune(home, oldest as string);
    expect(left()).toContain(oldest);
  });

  it("only regular pre-update-*.db files count: other names, folders, symlinks and temp files stay", () => {
    for (const [i, name] of names(1, 2, 3, 4).entries()) snap(name, i + 1);
    snap("pap-backup-20261001T000000Z.tar.gz", 0);
    snap("pre-restore-2026-10-01.db", 0);
    snap("pre-update-r9-2026-10-01T00-00-00-000Z.db.tmp", 0);
    mkdirSync(join(home, "backups", "pre-update-dir-2026.db"));
    symlinkSync("/etc/hostname", join(home, "backups", "pre-update-link-2026.db"));
    expect(prune(home)).toEqual(names(1));
    expect(left()).toEqual(
      [
        "pap-backup-20261001T000000Z.tar.gz",
        "pre-restore-2026-10-01.db",
        "pre-update-r9-2026-10-01T00-00-00-000Z.db.tmp",
        "pre-update-dir-2026.db",
        "pre-update-link-2026.db",
        ...names(2, 3, 4),
      ].sort(),
    );
  });

  it("no backups folder is not an error", () => {
    rmSync(join(home, "backups"), { recursive: true });
    expect(prune(home)).toEqual([]);
    expect(existsSync(join(home, "backups"))).toBe(false);
  });
});

const root = process.getuid?.() === 0;
describe.skipIf(root)("failures are reported, not swallowed (M6b-C3 review I1)", () => {
  afterEach(() => {
    chmodSync(join(home, "backups"), 0o700);
  });

  it("an entry that cannot be removed is in `failed`, the others are still removed", () => {
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    chmodSync(join(home, "backups"), 0o500); // listing works, removing does not
    const result = pruneSnapshots(home);
    expect(result.ran).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.failed.sort()).toEqual(names(1, 2).sort());
  });

  it("an unreadable backups folder is ran: false", () => {
    snap(names(1)[0] as string, 1);
    chmodSync(join(home, "backups"), 0o000);
    expect(pruneSnapshots(home)).toEqual({ ran: false, removed: [], failed: [] });
  });

  it("a file that vanishes between the listing and lstat does not abort the prune", () => {
    for (const [i, name] of names(1, 2, 3, 4, 5).entries()) snap(name, i + 1);
    const result = pruneSnapshots(home, null, 3, (path) => {
      if (path.endsWith(names(3)[0] as string)) rmSync(path); // the race
    });
    expect(result.ran).toBe(true);
    expect(result.removed).toEqual(names(1)); // 1, 2, 4, 5 remain: the three newest are kept
    expect(result.failed).toEqual([]);
  });

  it("no backups folder at all: ran true, nothing to do", () => {
    rmSync(join(home, "backups"), { recursive: true });
    expect(pruneSnapshots(home)).toEqual({ ran: true, removed: [], failed: [] });
    mkdirSync(join(home, "backups"));
  });
});
