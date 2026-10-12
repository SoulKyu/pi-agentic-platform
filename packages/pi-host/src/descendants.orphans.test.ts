import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countAgentProcesses,
  MAX_ENVIRON_BYTES,
  type ProcEntry,
  readBounded,
  SCOPE_PROCS_FILE,
} from "./descendants.ts";

// The worker is 10 and leads its group; 11 is its helper (an MCP server). The agent left 20 and 21 running: their
// shell exited, so Linux gave them to pid 1 (the bash tool's reparenting, M2-RT-14). 30 is someone else's.
const table: ProcEntry[] = [
  { pid: 10, ppid: 1, pgrp: 10 },
  { pid: 11, ppid: 10, pgrp: 10 },
  { pid: 20, ppid: 1, pgrp: 20 },
  { pid: 21, ppid: 1, pgrp: 20 },
  { pid: 30, ppid: 1, pgrp: 30 },
];
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const UNIT = "/user.slice/user-1000.slice/app-pap-ab.slice/app-pap-ab-cd.slice/pap-ab-worker-cd-1.scope";
const CGROUP = (path: string) => `0::${path}\n`;

function files(contents: Record<string, string | null>) {
  const reads: Array<{ path: string; max: number }> = [];
  const readFile = (path: string, max: number): string | null => {
    reads.push({ path, max });
    return contents[path] ?? null;
  };
  return { readFile, reads };
}
const count = (extra: Parameters<typeof countAgentProcesses>[0]) =>
  countAgentProcesses({ platform: "linux", pid: 10, readTable: () => table, ...extra });

describe("processes the agent left running, reparented away from the worker (the bash tool's `cmd &`)", () => {
  describe("in the worker's own scope", () => {
    const scoped = (procs: string) => ({
      "/proc/self/cgroup": CGROUP(UNIT),
      [`/sys/fs/cgroup${UNIT}/cgroup.procs`]: procs,
    });

    it("counts the scope's members outside the worker's group, wherever they were reparented", () => {
      const { readFile, reads } = files(scoped("10\n11\n20\n21\n99\n"));
      expect(count({ readFile })).toBe(2);
      // A scoped worker does not scan the environment of every process.
      expect(reads.map((read) => read.path)).toEqual([
        "/proc/self/cgroup",
        `/sys/fs/cgroup${UNIT}/cgroup.procs`,
      ]);
      expect(reads.every((read) => read.max > 0 && read.max <= 1024 * 1024)).toBe(true);
    });

    it("counts a process once when it is both a descendant and a member", () => {
      const withChild = [...table, { pid: 12, ppid: 10, pgrp: 12 }];
      const { readFile } = files(scoped("10\n11\n12\n20\n"));
      expect(count({ readFile, readTable: () => withChild })).toBe(2);
    });

    it("still counts a detached descendant the scope file does not list", () => {
      const withChild = [...table, { pid: 12, ppid: 10, pgrp: 12 }];
      const { readFile } = files(scoped("10\n11\n20\n"));
      expect(count({ readFile, readTable: () => withChild })).toBe(2);
    });

    it("leaves out members that are not live processes (gone, or a pid the table never had)", () => {
      const { readFile } = files(scoped("10\n99\n100\nnot-a-pid\n"));
      expect(count({ readFile })).toBe(0);
    });

    it("reads no more than maxVisited members", () => {
      const { readFile } = files(scoped("20\n21\n30\n"));
      expect(count({ readFile, maxVisited: 2 })).toBe(2);
    });
  });

  describe("without a scope of pap's (scopes off, no systemd): the worker's marker in the environment", () => {
    const environ = (...vars: string[]) => `${vars.join("\0")}\0`;
    const marked = environ("HOME=/h", `PAP_WORKER_TOKEN=${TOKEN}`);
    const world = {
      "/proc/self/cgroup": CGROUP("/user.slice/user-1000.slice/session-4.scope"),
      "/proc/11/environ": marked,
      "/proc/20/environ": marked,
      "/proc/21/environ": environ(`PAP_WORKER_TOKEN=${TOKEN}`, "HOME=/h"),
      "/proc/30/environ": environ("HOME=/h", `PAP_WORKER_TOKEN=${"f".repeat(32)}`),
    };

    it("counts live processes that carry this worker's token, minus the worker's group", () => {
      const { readFile, reads } = files(world);
      expect(count({ readFile, token: TOKEN })).toBe(2);
      expect(reads.map((read) => read.path)).not.toContain(
        "/sys/fs/cgroup/user.slice/user-1000.slice/session-4.scope/cgroup.procs",
      );
      expect(
        reads
          .filter((read) => read.path.endsWith("/environ"))
          .every((read) => read.max === MAX_ENVIRON_BYTES),
      ).toBe(true);
    });

    it("takes the whole entry: a token that is only a prefix of another one does not match", () => {
      const { readFile } = files({
        ...world,
        "/proc/20/environ": environ(`PAP_WORKER_TOKEN=${TOKEN}0`),
        "/proc/21/environ": environ(`X_PAP_WORKER_TOKEN=${TOKEN}`),
      });
      expect(count({ readFile, token: TOKEN })).toBe(0);
    });

    it("counts a process whose environment cannot be read as not ours", () => {
      const { readFile } = files({ ...world, "/proc/20/environ": null });
      expect(count({ readFile, token: TOKEN })).toBe(1);
    });

    it("falls back to the marker when the scope cannot be read", () => {
      const { readFile } = files({ ...world, "/proc/self/cgroup": CGROUP(UNIT) });
      expect(count({ readFile, token: TOKEN })).toBe(2);
    });

    it("does not follow a cgroup path that climbs out of the cgroup tree", () => {
      const { readFile, reads } = files({
        ...world,
        "/proc/self/cgroup": CGROUP("/user.slice/../../../etc/pap-ab-worker-cd-1.scope"),
      });
      expect(count({ readFile, token: TOKEN })).toBe(2);
      expect(reads.filter((read) => read.path.endsWith(SCOPE_PROCS_FILE))).toEqual([]);
    });

    it("does not scan without a token of a usable length", () => {
      const { readFile, reads } = files(world);
      expect(count({ readFile })).toBe(0);
      expect(count({ readFile, token: "short" })).toBe(0);
      expect(reads.filter((read) => read.path.endsWith("/environ"))).toEqual([]);
    });

    it("stops reading environments once the total budget is spent", () => {
      const { readFile, reads } = files(world);
      const each = marked.length;
      expect(count({ readFile, token: TOKEN, maxEnvironTotal: each })).toBe(1);
      expect(reads.filter((read) => read.path.endsWith("/environ")).map((read) => read.path)).toEqual([
        "/proc/20/environ",
      ]);
    });
  });

  it("is 0 off Linux without reading anything, and never throws", () => {
    const { readFile, reads } = files({});
    expect(count({ readFile, platform: "darwin", token: TOKEN })).toBe(0);
    expect(reads).toEqual([]);
    const throwing = () => {
      throw new Error("EIO");
    };
    expect(count({ readFile: throwing, token: TOKEN, warn: () => {} })).toBe(0);
  });
});

describe("readBounded", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads at most the bytes asked for, and nothing from a file it cannot open", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-bounded-"));
    const file = join(dir, "environ");
    writeFileSync(file, "x".repeat(1000));
    expect(readBounded(file, 100)).toBe("x".repeat(100));
    expect(readBounded(file, 5000)).toBe("x".repeat(1000));
    expect(readBounded(join(dir, "missing"), 100)).toBeNull();
    expect(SCOPE_PROCS_FILE).toBe("cgroup.procs");
  });
});
