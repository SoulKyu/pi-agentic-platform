import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  countAgentProcesses,
  descendantsOf,
  entryOf,
  installSignalCleanup,
  killDetachedDescendants,
  parseStat,
  type ProcEntry,
  readProcTable,
  stateOf,
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

describe("countAgentProcesses", () => {
  const entries = [
    { pid: 10, ppid: 1, pgrp: 10 },
    { pid: 11, ppid: 10, pgrp: 10 },
    { pid: 12, ppid: 10, pgrp: 12 },
    { pid: 13, ppid: 12, pgrp: 12 },
  ];
  const count = (table: readonly ProcEntry[], extra: Parameters<typeof countAgentProcesses>[0] = {}) =>
    countAgentProcesses({ platform: "linux", pid: 10, readTable: () => [...table], ...extra });

  it("counts the processes the agent started, not the worker's own helpers (M2-RT-14)", () => {
    expect(count(entries)).toBe(2);
    expect(count(entries, { platform: "darwin" })).toBe(0);
  });

  it("counts a grandchild of a helper that left the group, and nothing of a helper's own children in the group", () => {
    const table = [...entries, { pid: 14, ppid: 11, pgrp: 10 }, { pid: 15, ppid: 11, pgrp: 15 }];
    expect(count(table)).toBe(3);
  });

  it("is 0 when the worker does not lead its group (run by hand) or is not in the table", () => {
    expect(count(entries.map((e) => (e.pid === 10 ? { ...e, pgrp: 7 } : e)))).toBe(0);
    expect(count(entries.filter((e) => e.pid !== 10))).toBe(0);
    expect(count([])).toBe(0);
  });

  it("never throws: a failed read is 0 and says so once on stderr", () => {
    const lines: string[] = [];
    const failing = {
      readTable: () => {
        throw new Error("EACCES: /proc");
      },
      warn: (line: string) => void lines.push(line),
    };
    expect(count(entries, failing)).toBe(0);
    expect(count(entries, failing)).toBe(0);
    expect(lines).toEqual(["pi-host: the process count failed: EACCES: /proc\n"]);
  });

  it("counts a pid once when it was listed twice, and never the worker itself (a pid reused between two reads)", () => {
    const table = [
      ...entries,
      { pid: 12, ppid: 99, pgrp: 12 },
      { pid: 10, ppid: 13, pgrp: 10 },
      { pid: 16, ppid: 16, pgrp: 16 },
    ];
    expect(count(table)).toBe(2);
  });

  it("ignores a child whose parent left the table mid-read", () => {
    expect(count([...entries, { pid: 20, ppid: 19, pgrp: 20 }])).toBe(2);
  });

  it("looks at no more than maxVisited processes, and no deeper than maxDepth", () => {
    const fan = Array.from({ length: 10 }, (_, i) => ({ pid: 100 + i, ppid: 10, pgrp: 100 + i }));
    expect(count([entries[0] as ProcEntry, ...fan], { maxVisited: 4 })).toBe(4);
    const chain = Array.from({ length: 6 }, (_, i) => ({
      pid: 100 + i,
      ppid: i === 0 ? 10 : 99 + i,
      pgrp: 100 + i,
    }));
    expect(count([entries[0] as ProcEntry, ...chain], { maxDepth: 3 })).toBe(3);
    expect(count([entries[0] as ProcEntry, ...chain])).toBe(6);
  });

  it("walks a wide table once: 20000 processes in a few milliseconds", () => {
    const wide = Array.from({ length: 20_000 }, (_, i) => ({ pid: 1000 + i, ppid: 100 + (i % 50), pgrp: 1 }));
    const started = performance.now();
    expect(count([...entries, ...wide])).toBe(2);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("stateOf and the table", () => {
  it("reads the state letter after a command name with spaces and parentheses", () => {
    expect(stateOf("123 (my (odd) name) Z 45 67 89")).toBe("Z");
    expect(stateOf("9 (sleep) S 1 9 9")).toBe("S");
    expect(stateOf("garbage")).toBeNull();
  });

  it("leaves out a zombie and a dead process, and what is not a stat line", () => {
    expect(entryOf(7, "7 (a b) S 1 7 7 0")).toEqual({ pid: 7, ppid: 1, pgrp: 7 });
    expect(entryOf(7, "7 (a b) Z 1 7 7 0")).toBeNull();
    expect(entryOf(7, "7 (a b) X 1 7 7 0")).toBeNull();
    expect(entryOf(7, "7 (a b) S")).toBeNull();
  });

  it("lists this process, and reads no more than the limit", () => {
    expect(readProcTable().some((entry) => entry.pid === process.pid)).toBe(true);
    expect(readProcTable(1)).toHaveLength(1);
  });
});
