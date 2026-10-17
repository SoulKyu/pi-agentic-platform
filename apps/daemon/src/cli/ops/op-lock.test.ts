import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireOpLock, OpLockBusy, processStart } from "./op-lock.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-oplock-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const lockPath = () => join(home, "update", "op.lock");
const exists = () => {
  try {
    statSync(lockPath());
    return true;
  } catch {
    return false;
  }
};

/** pid -> start time of the processes this test pretends are alive. */
const table = new Map<number, string>();
const startOf = (pid: number): string | null => table.get(pid) ?? null;
beforeEach(() => table.clear());

describe("acquireOpLock", () => {
  it("a second holder is refused naming the pid; release removes the file and a third acquire works", () => {
    table.set(111, "500");
    table.set(222, "600");
    const release = acquireOpLock(home, 111, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("111 500\n");
    expect(() => acquireOpLock(home, 222, startOf)).toThrow(OpLockBusy);
    expect(() => acquireOpLock(home, 222, startOf)).toThrow(/pid 111/);
    expect(readFileSync(lockPath(), "utf8")).toBe("111 500\n");
    release();
    expect(exists()).toBe(false);
    const third = acquireOpLock(home, 222, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
    third();
  });

  it("a stale file whose pid is not alive is replaced", () => {
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "999 123\n");
    acquireOpLock(home, 222, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
  });

  it("a file whose pid is alive with another start time (recycled pid) is replaced", () => {
    table.set(111, "999");
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "111 500\n");
    acquireOpLock(home, 222, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
  });

  it("a garbage file is replaced", () => {
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "not a lock\n");
    acquireOpLock(home, 222, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
  });

  it("a release called twice, or after another holder replaced the file, never removes the other holder's file", () => {
    table.set(111, "500");
    table.set(222, "600");
    const first = acquireOpLock(home, 111, startOf);
    first();
    const second = acquireOpLock(home, 222, startOf);
    first();
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
    second();
    expect(exists()).toBe(false);
    second();
    expect(exists()).toBe(false);
  });

  it("an empty file written a moment ago is a holder mid-write: refused, not replaced", () => {
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "");
    expect(() => acquireOpLock(home, 222, startOf)).toThrow(/is starting/);
    expect(readFileSync(lockPath(), "utf8")).toBe("");
  });

  it("an empty file left by a crash long ago is stale and replaced", () => {
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), old, old);
    acquireOpLock(home, 222, startOf);
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
  });

  it("a lock released between the failed create and the read is retried, not a raw ENOENT", () => {
    table.set(111, "500");
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "111 500\n");
    acquireOpLock(home, 222, startOf, { afterCollision: () => rmSync(lockPath()) });
    expect(readFileSync(lockPath(), "utf8")).toBe("222 600\n");
  });

  it("a stale file replaced by a live holder before the removal is not removed (compare before remove)", () => {
    table.set(111, "500");
    table.set(222, "600");
    mkdirSyncUpdate();
    writeFileSync(lockPath(), "999 123\n");
    let swapped = false;
    const hooks = {
      beforeRemove: () => {
        if (swapped) return;
        swapped = true;
        writeFileSync(lockPath(), "111 500\n"); // another acquirer won the replacement
      },
    };
    expect(() => acquireOpLock(home, 222, startOf, hooks)).toThrow(/pid 111/);
    expect(readFileSync(lockPath(), "utf8")).toBe("111 500\n");
  });

  it("the file is 0600 in a 0700 folder", () => {
    table.set(111, "500");
    acquireOpLock(home, 111, startOf);
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "update")).mode & 0o777).toBe(0o700);
  });

  it("with the real process table a second acquire names this process", () => {
    const release = acquireOpLock(home);
    try {
      expect(() => acquireOpLock(home)).toThrow(new RegExp(`pid ${process.pid}\\)`));
    } finally {
      release();
    }
    expect(exists()).toBe(false);
  });
});

describe("processStart", () => {
  it("is a number of ticks for this process and null for a pid that does not exist", () => {
    expect(processStart(process.pid)).toMatch(/^\d+$/);
    expect(processStart(2 ** 22 + 12345)).toBeNull();
  });
});

function mkdirSyncUpdate(): void {
  mkdirSync(join(home, "update"), { recursive: true, mode: 0o700 });
}
