import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  descendantsOf,
  installSignalCleanup,
  killDetachedDescendants,
  parseStat,
  type ProcEntry,
  readProcTable,
} from "./descendants.ts";

// The worker is 100, led by the daemon's group of its own. Pi's bash tool started 200 detached (a session and
// group of its own); `sleep` 201 shares that group; 300 started itself in yet another session.
const WORKER = 100;
const table: ProcEntry[] = [
  { pid: 50, ppid: 1, pgrp: 50 },
  { pid: WORKER, ppid: 50, pgrp: WORKER },
  { pid: 150, ppid: WORKER, pgrp: WORKER },
  { pid: 200, ppid: WORKER, pgrp: 200 },
  { pid: 201, ppid: 200, pgrp: 200 },
  { pid: 300, ppid: 201, pgrp: 300 },
  { pid: 301, ppid: 300, pgrp: 300 },
  { pid: 400, ppid: 1, pgrp: 400 },
];

function run(overrides: Partial<Parameters<typeof killDetachedDescendants>[0]> = {}) {
  const signals: string[] = [];
  // The kills work: the second sweep finds only the worker.
  let reads = 0;
  const killed = killDetachedDescendants({
    platform: "linux",
    pid: WORKER,
    readTable: () => (reads++ === 0 ? table : table.filter((entry) => entry.pid <= WORKER)),
    kill: (pid, signal) => void signals.push(`${pid}:${signal}`),
    ...overrides,
  });
  return { killed, signals };
}

describe("parseStat", () => {
  it("reads parent and group after a command name with spaces and parentheses", () => {
    expect(parseStat("123 (my (odd) name) S 45 67 89 0 -1")).toEqual({ ppid: 45, pgrp: 67 });
    expect(parseStat("9 (sleep) R 1 9 9")).toEqual({ ppid: 1, pgrp: 9 });
  });

  it("refuses what is not a stat line", () => {
    expect(parseStat("")).toBeNull();
    expect(parseStat("12 (x) S")).toBeNull();
    expect(parseStat("12 (x) S a b")).toBeNull();
  });
});

describe("descendantsOf", () => {
  it("walks the children of children and nothing else", () => {
    expect(descendantsOf(table, WORKER).map((entry) => entry.pid)).toEqual([150, 200, 201, 300, 301]);
    expect(descendantsOf(table, 400)).toEqual([]);
    expect(descendantsOf(table, 12345)).toEqual([]);
  });

  it("terminates on a table that loops back to the root", () => {
    const looped: ProcEntry[] = [
      { pid: 1000, ppid: 1001, pgrp: 1000 },
      { pid: 1001, ppid: 1000, pgrp: 1000 },
    ];
    expect(descendantsOf(looped, 1000).map((entry) => entry.pid)).toEqual([1001]);
  });
});

describe("killDetachedDescendants", () => {
  it("kills the groups its descendants lead, then every descendant, and nothing outside", () => {
    const { killed, signals } = run();
    expect(signals).toEqual([
      "-200:SIGKILL",
      "-300:SIGKILL",
      "150:SIGKILL",
      "200:SIGKILL",
      "201:SIGKILL",
      "300:SIGKILL",
      "301:SIGKILL",
    ]);
    expect(killed).toBe(5);
  });

  it("never signals its own group, its parent's, or the group of a process it did not start", () => {
    const signals = run().signals;
    for (const refused of ["-100:", "-50:", "-400:", "50:", "400:", "0:", "-0:", "-1:", "1:"]) {
      expect(signals.some((signal) => signal.startsWith(refused))).toBe(false);
    }
  });

  it("does nothing unless the worker leads a group of its own", () => {
    const shared = table.map((entry) => (entry.pid === WORKER ? { ...entry, pgrp: 50 } : entry));
    expect(run({ readTable: () => shared })).toEqual({ killed: 0, signals: [] });
  });

  it("does nothing when it cannot see itself in the table", () => {
    expect(run({ readTable: () => table.filter((entry) => entry.pid !== WORKER) })).toEqual({
      killed: 0,
      signals: [],
    });
  });

  it("does nothing off Linux, where there is no /proc to walk", () => {
    expect(run({ platform: "darwin" })).toEqual({ killed: 0, signals: [] });
  });

  it("goes on when a process is already gone, and never throws", () => {
    const seen: string[] = [];
    const killed = killDetachedDescendants({
      platform: "linux",
      pid: WORKER,
      readTable: () => table,
      kill: (pid, signal) => {
        seen.push(`${pid}:${signal}`);
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });
    expect(killed).toBe(0);
    expect(seen).toHaveLength(7);
    expect(() =>
      killDetachedDescendants({
        platform: "linux",
        pid: WORKER,
        readTable: () => {
          throw new Error("/proc is not readable");
        },
        kill: () => {},
      }),
    ).not.toThrow();
  });
});

describe("killDetachedDescendants sweeps", () => {
  it("sweeps again until nothing is left, at most three times", () => {
    const tables = [
      [
        { pid: 10, ppid: 1, pgrp: 10 },
        { pid: 11, ppid: 10, pgrp: 11 },
      ],
      [
        { pid: 10, ppid: 1, pgrp: 10 },
        { pid: 12, ppid: 10, pgrp: 12 },
      ],
      [{ pid: 10, ppid: 1, pgrp: 10 }],
    ];
    let reads = 0;
    const killed: number[] = [];
    const count = killDetachedDescendants({
      platform: "linux",
      pid: 10,
      readTable: () => tables[Math.min(reads++, tables.length - 1)] ?? [],
      kill: (target) => void killed.push(target),
    });
    expect(count).toBe(2);
    expect(killed).toEqual([-11, 11, -12, 12]);
    expect(reads).toBe(3);
  });

  it("stops after three sweeps when processes keep appearing", () => {
    let reads = 0;
    const count = killDetachedDescendants({
      platform: "linux",
      pid: 10,
      readTable: () => [
        { pid: 10, ppid: 1, pgrp: 10 },
        { pid: 20 + reads++, ppid: 10, pgrp: 10 },
      ],
      kill: () => {},
    });
    expect(count).toBe(3);
    expect(reads).toBe(3);
  });
});

describe("readProcTable", () => {
  it.runIf(process.platform === "linux")(
    "reads this process from /proc with its real parent and group",
    () => {
      const me = readProcTable().find((entry) => entry.pid === process.pid);
      expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid });
      expect(me?.pgrp).toBeGreaterThan(0);
    },
  );
});

describe("installSignalCleanup", () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const kill = vi.fn();
    return Object.assign(emitter, { pid: 4321, kill }) as unknown as NodeJS.Process & {
      kill: ReturnType<typeof vi.fn>;
    };
  }

  it.each(["SIGTERM", "SIGHUP"] as const)(
    "cleans up on %s and then dies of the same signal, so the exit still reads as a signal",
    (signal) => {
      const proc = fakeProcess();
      const order: string[] = [];
      proc.kill.mockImplementation((_pid: number, sent: string) => void order.push(`kill:${sent}`));
      installSignalCleanup(proc, () => void order.push("cleanup"));
      proc.emit(signal);
      expect(order).toEqual(["cleanup", `kill:${signal}`]);
      expect(proc.kill).toHaveBeenCalledWith(4321, signal);
      // The handler is gone: the signal it re-raises takes the default action.
      expect(proc.listenerCount(signal)).toBe(0);
    },
  );

  it("still dies when the cleanup fails", () => {
    const proc = fakeProcess();
    installSignalCleanup(proc, () => {
      throw new Error("boom");
    });
    proc.emit("SIGTERM");
    expect(proc.kill).toHaveBeenCalledWith(4321, "SIGTERM");
  });
});
