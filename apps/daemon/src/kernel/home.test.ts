import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock, HomeError, InstanceLockError, prepareHome, startTimeOf } from "./home.ts";

// A file system without hard links answers linkSync with an error; the real one never does here.
const fsHooks = vi.hoisted(() => ({ link: null as (() => void) | null, chmodIgnored: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // A volume that accepts chmod and keeps the old mode (some FUSE, CIFS, vfat mounts): the call succeeds, nothing changes.
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (!fsHooks.chmodIgnored) actual.chmodSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      fsHooks.link?.();
      return actual.linkSync(...args);
    },
  };
});

const mode = (path: string) => statSync(path).mode & 0o777;
const linux = process.platform === "linux";
let root: string;
let home: string;
let umask: number;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-home-"));
  home = join(root, "pap-home");
  umask = process.umask(0o022);
});
afterEach(() => {
  fsHooks.link = null;
  fsHooks.chmodIgnored = false;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  process.umask(umask);
  rmSync(root, { recursive: true, force: true });
});

// The pid of a process that has ended: nothing holds it any more.
const deadPid = (): number =>
  Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString());
// A process that stays: its pid is live, so only its start time can tell it from the one that took the lock.
function livePid(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child.pid ?? 0;
}

describe("prepareHome", () => {
  it("makes the home and the directories it owns 0700 and files created afterwards 0600 (R68)", () => {
    prepareHome(home);
    for (const dir of [
      home,
      join(home, "backups"),
      join(home, "secrets"),
      join(home, "logs"),
      join(home, "exports"),
    ]) {
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

  it("returns the umask the process started with, once, whatever it is by the next call (R114b)", async () => {
    vi.resetModules();
    const fresh = await import("./home.ts");
    process.umask(0o002);
    expect(fresh.prepareHome(home)).toBe(0o002);
    expect(process.umask()).toBe(0o077);
    expect(fresh.prepareHome(home)).toBe(0o002);
  });

  it("tightens a home, its directories and its database files that an earlier run left open (R117)", () => {
    mkdirSync(join(home, "backups"), { recursive: true });
    mkdirSync(join(home, "secrets"));
    mkdirSync(join(home, "logs"));
    const loose = [
      [home, 0o755],
      [join(home, "backups"), 0o755],
      [join(home, "secrets"), 0o750],
      [join(home, "logs"), 0o777],
    ] as const;
    for (const [path, open] of loose) chmodSync(path, open);
    for (const name of ["state.db", "state.db-wal", "state.db-shm"]) {
      writeFileSync(join(home, name), "x");
      chmodSync(join(home, name), 0o644);
    }
    prepareHome(home);
    for (const [path] of loose) expect(mode(path), path).toBe(0o700);
    for (const name of ["state.db", "state.db-wal", "state.db-shm"]) {
      expect(mode(join(home, name)), name).toBe(0o600);
    }
  });

  it("never chmods through a symlinked database file, and still follows a symlinked home (R119)", () => {
    const real = join(root, "real-home");
    mkdirSync(real, { mode: 0o755 });
    chmodSync(real, 0o755);
    symlinkSync(real, home);
    const outside = join(root, "outside");
    mkdirSync(outside);
    const names = ["state.db", "state.db-wal", "state.db-shm"];
    for (const name of names) {
      const target = join(outside, name);
      writeFileSync(target, "x");
      chmodSync(target, 0o644);
      symlinkSync(target, join(real, name));
    }
    prepareHome(home);
    expect(mode(real)).toBe(0o700);
    expect(mode(join(real, "backups"))).toBe(0o700);
    for (const name of names) expect(mode(join(outside, name)), name).toBe(0o644);
  });

  it("names the path it cannot make private instead of failing with a bare errno", () => {
    mkdirSync(home);
    writeFileSync(join(home, "backups"), "a file where a directory belongs");
    expect(() => prepareHome(home)).toThrow(HomeError);
    expect(() => prepareHome(home)).toThrow(join(home, "backups"));
  });
});

describe("prepareHome on a file system that ignores chmod (R119)", () => {
  it("refuses to boot, naming the path and saying the file system ignores permissions", () => {
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    fsHooks.chmodIgnored = true;
    expect(() => prepareHome(home)).toThrow(HomeError);
    expect(() => prepareHome(home)).toThrow(home);
    expect(() => prepareHome(home)).toThrow(/ignores permissions/);
    expect(() => prepareHome(home)).toThrow(/local disk|PAP_HOME/);
  });

  it("refuses when only a private subfolder keeps its open mode", () => {
    prepareHome(home);
    chmodSync(join(home, "secrets"), 0o755);
    fsHooks.chmodIgnored = true;
    expect(() => prepareHome(home)).toThrow(join(home, "secrets"));
  });

  it("refuses an open database file the same way", () => {
    prepareHome(home);
    writeFileSync(join(home, "state.db"), "x");
    chmodSync(join(home, "state.db"), 0o644);
    fsHooks.chmodIgnored = true;
    expect(() => prepareHome(home)).toThrow(/ignores permissions/);
  });

  it("boots on a file system that honours chmod", () => {
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(() => prepareHome(home)).not.toThrow();
    expect(mode(home)).toBe(0o700);
  });
});

describe("acquireInstanceLock", () => {
  beforeEach(() => void prepareHome(home));

  it("takes the lock with this pid, 0600, and gives it back", () => {
    const lock = acquireInstanceLock(home);
    expect(readFileSync(join(home, "pap.lock"), "utf8").split(/\s/)[0]).toBe(String(process.pid));
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

  it("takes over a lock with our own pid that this process does not hold: a container restart (R116)", () => {
    // In an OCI container the daemon is pid 1 every time, so the lock a killed run left behind names the new one.
    writeFileSync(join(home, "pap.lock"), `${process.pid}\n`);
    const lock = acquireInstanceLock(home);
    expect(() => acquireInstanceLock(home)).toThrow(InstanceLockError);
    lock.release();
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
  });

  it("replaces a lock whose owner is gone, and one that holds nothing readable", () => {
    writeFileSync(join(home, "pap.lock"), `${deadPid()}\n`);
    acquireInstanceLock(home).release();
    writeFileSync(join(home, "pap.lock"), "not a pid");
    acquireInstanceLock(home).release();
    writeFileSync(join(home, "pap.lock"), "");
    acquireInstanceLock(home).release();
  });

  it.runIf(linux)(
    "records the start time and tells a recycled pid from the process that took the lock",
    () => {
      const other = livePid();
      const started = startTimeOf(other);
      expect(started).toMatch(/^\d+$/);
      writeFileSync(join(home, "pap.lock"), `${other} ${started}\n`);
      expect(() => acquireInstanceLock(home)).toThrow(`(pid ${other})`);
      // The same pid, started at another time: the machine rebooted or the pid wrapped round.
      writeFileSync(join(home, "pap.lock"), `${other} ${Number(started) + 1}\n`);
      const lock = acquireInstanceLock(home);
      expect(readFileSync(join(home, "pap.lock"), "utf8").trim()).toBe(
        `${process.pid} ${startTimeOf(process.pid)}`,
      );
      lock.release();
    },
  );

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

  it("says what is missing when the file system cannot make hard links, and leaves no file behind", () => {
    fsHooks.link = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    expect(() => acquireInstanceLock(home)).toThrow(InstanceLockError);
    expect(() => acquireInstanceLock(home)).toThrow(/hard links.*EPERM|EPERM.*hard links/s);
    expect(() => acquireInstanceLock(home)).toThrow(join(home, "pap.lock"));
    expect(existsSync(join(home, `pap.lock.${process.pid}.tmp`))).toBe(false);
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
  });

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"])(
    "hints at hard links for %s (R119)",
    (code) => {
      fsHooks.link = () => {
        throw Object.assign(new Error("link failed"), { code });
      };
      expect(() => acquireInstanceLock(home)).toThrow(
        `(${code}). $PAP_HOME needs a file system that allows hard links.`,
      );
    },
  );

  it.each(["EACCES", "ENOSPC", "EROFS", "EIO"])(
    "gives the bare code and no hard-link hint for %s (R119)",
    (code) => {
      fsHooks.link = () => {
        throw Object.assign(new Error("link failed"), { code });
      };
      let message = "";
      try {
        acquireInstanceLock(home);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`(${code})`);
      expect(message).toContain(join(home, "pap.lock"));
      expect(message).not.toContain("hard links");
    },
  );
});
