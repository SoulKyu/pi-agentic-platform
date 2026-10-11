import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, InstanceLockError, prepareHome } from "./home.ts";

const mode = (path: string) => statSync(path).mode & 0o777;
let root: string;
let home: string;
let umask: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-home-"));
  home = join(root, "pap-home");
  umask = process.umask(0o022);
});
afterEach(() => {
  process.umask(umask);
  rmSync(root, { recursive: true, force: true });
});

// The pid of a process that has ended: nothing holds it any more.
const deadPid = (): number =>
  Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString());

describe("prepareHome", () => {
  it("makes the home and the directories it owns 0700 and files created afterwards 0600 (R68)", () => {
    prepareHome(home);
    for (const dir of [home, join(home, "backups"), join(home, "secrets"), join(home, "logs")]) {
      expect(mode(dir), dir).toBe(0o700);
    }
    writeFileSync(join(home, "state.db"), "x");
    expect(mode(join(home, "state.db"))).toBe(0o600);
    expect(process.umask()).toBe(0o077);
  });

  it("keeps what is already in a home that exists", () => {
    prepareHome(home);
    writeFileSync(join(home, "keep.txt"), "kept");
    prepareHome(home);
    expect(readFileSync(join(home, "keep.txt"), "utf8")).toBe("kept");
  });
});

describe("acquireInstanceLock", () => {
  beforeEach(() => prepareHome(home));

  it("takes the lock with this pid, 0600, and gives it back", () => {
    const lock = acquireInstanceLock(home);
    expect(readFileSync(join(home, "pap.lock"), "utf8").trim()).toBe(String(process.pid));
    expect(mode(join(home, "pap.lock"))).toBe(0o600);
    lock.release();
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
    acquireInstanceLock(home).release();
  });

  it("refuses a second instance on the same home, naming the home, the pid and the file", () => {
    const first = acquireInstanceLock(home);
    const second = () => acquireInstanceLock(home);
    expect(second).toThrow(InstanceLockError);
    expect(second).toThrow(`pap is already running on ${home} (pid ${process.pid})`);
    expect(second).toThrow(join(home, "pap.lock"));
    first.release();
  });

  it("replaces a lock whose owner is gone, and one that holds nothing readable", () => {
    writeFileSync(join(home, "pap.lock"), `${deadPid()}\n`);
    acquireInstanceLock(home).release();
    writeFileSync(join(home, "pap.lock"), "not a pid");
    acquireInstanceLock(home).release();
    writeFileSync(join(home, "pap.lock"), "");
    acquireInstanceLock(home).release();
  });

  it("does not remove a lock somebody else holds when released late", () => {
    const lock = acquireInstanceLock(home);
    writeFileSync(join(home, "pap.lock"), `${deadPid()}\n`);
    lock.release();
    expect(existsSync(join(home, "pap.lock"))).toBe(true);
  });

  it("leaves no temporary file behind, whether the lock was taken or refused", () => {
    const temp = join(home, `pap.lock.${process.pid}.tmp`);
    const lock = acquireInstanceLock(home);
    expect(existsSync(temp)).toBe(false);
    expect(() => acquireInstanceLock(home)).toThrow(InstanceLockError);
    expect(existsSync(temp)).toBe(false);
    lock.release();
  });
});
