import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import {
  type ProcEntry,
  type ProcReader,
  PTY_EXIT_WAIT_MS,
  PTY_HANGUP_GRACE_MS,
  parseProcStat,
  ptyKill,
  sessionMembers,
} from "./kill.ts";

const SHELL = 1234;

const denied = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });

function setup(
  options: {
    shellStart?: string;
    deny?: readonly number[];
    onSignal?: (target: number, name: string) => void;
  } = {},
) {
  const clock = createFakeClock();
  const started = clock.now();
  const table = new Map<number, { sid: number; start: string }>([
    [SHELL, { sid: SHELL, start: options.shellStart ?? "100" }],
    [2001, { sid: SHELL, start: "200" }],
    [2002, { sid: SHELL, start: "201" }],
    [3000, { sid: 999, start: "300" }],
  ]);
  const proc: ProcReader = {
    entry: async (pid) => {
      const row = table.get(pid);
      return row ? ({ pid, ...row } satisfies ProcEntry) : null;
    },
    pids: async () => [...table.keys()],
  };
  const sent: Array<{ at: number; target: number; name: string }> = [];
  const signal = (target: number, name: NodeJS.Signals) => {
    options.onSignal?.(target, name);
    if (options.deny?.includes(target)) throw denied();
    sent.push({ at: clock.now() - started, target, name });
    if (name === "SIGKILL" && target > 0) table.delete(target);
  };
  let exit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const warn = vi.fn();
  const target = { pid: SHELL, start: "100", exited };
  return {
    clock,
    table,
    proc,
    sent,
    signal,
    exit,
    warn,
    target,
  };
}
type World = ReturnType<typeof setup>;
const run = (w: World) => ptyKill(w.target, { clock: w.clock, warn: w.warn, proc: w.proc, signal: w.signal });
const hangup = [
  { at: 0, target: -SHELL, name: "SIGHUP" },
  { at: 0, target: 2001, name: "SIGHUP" },
  { at: 0, target: 2002, name: "SIGHUP" },
];

describe("ptyKill", () => {
  it("hangs up the shell's group and every process of its session at once, never another session", async () => {
    const w = setup();
    void run(w);
    await w.clock.advance(1);
    expect(w.sent).toEqual(hangup);
    expect(w.sent.some((s) => s.target === 3000)).toBe(false);
  });

  it("ends when the shell exits and its session is empty: no SIGKILL, no timer left", async () => {
    const w = setup();
    const done = run(w);
    await w.clock.advance(500);
    w.table.delete(2001);
    w.table.delete(2002);
    w.table.delete(SHELL);
    w.exit();
    await done;
    expect(w.sent).toEqual(hangup);
    expect(w.clock.pending()).toBe(0);
    await w.clock.advance(10_000);
    expect(w.sent).toEqual(hangup);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it("kills the group and a surviving member after 2 s even though the shell exited at 500 ms", async () => {
    const w = setup();
    const done = run(w);
    await w.clock.advance(500);
    w.table.delete(SHELL);
    w.table.delete(2002);
    w.exit();
    await w.clock.advance(PTY_HANGUP_GRACE_MS - 501);
    expect(w.sent.filter((s) => s.name === "SIGKILL")).toEqual([]);
    await w.clock.advance(1);
    expect(w.sent.filter((s) => s.name === "SIGKILL")).toEqual([
      { at: PTY_HANGUP_GRACE_MS, target: -SHELL, name: "SIGKILL" },
      { at: PTY_HANGUP_GRACE_MS, target: 2001, name: "SIGKILL" },
    ]);
    w.table.delete(2001);
    await done;
    expect(w.warn).not.toHaveBeenCalled();
    expect(w.clock.pending()).toBe(0);
  });

  it("kills at 2 s when the shell never exits, logs pty_kill_timeout at 7 s and resolves anyway", async () => {
    const w = setup();
    let resolved = false;
    void run(w).then(() => {
      resolved = true;
    });
    await w.clock.advance(PTY_HANGUP_GRACE_MS - 1);
    expect(w.sent.filter((s) => s.name === "SIGKILL")).toEqual([]);
    await w.clock.advance(1);
    expect(w.sent.filter((s) => s.name === "SIGKILL").map((s) => s.target)).toEqual([-SHELL, 2001, 2002]);
    await w.clock.advance(PTY_EXIT_WAIT_MS - 1);
    expect(resolved).toBe(false);
    expect(w.warn).not.toHaveBeenCalled();
    await w.clock.advance(1);
    expect(w.warn).toHaveBeenCalledExactlyOnceWith("pty_kill_timeout", { pid: SHELL });
    expect(resolved).toBe(true);
    expect(w.clock.pending()).toBe(0);
  });

  it("resolves at once when the shell exits after the SIGKILL, without the timeout log", async () => {
    const w = setup();
    const done = run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS);
    w.exit();
    await done;
    expect(w.warn).not.toHaveBeenCalled();
    expect(w.clock.pending()).toBe(0);
  });

  it("signals nothing when the pid now names another process (another start time)", async () => {
    const w = setup({ shellStart: "999" });
    void run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS + PTY_EXIT_WAIT_MS);
    expect(w.sent).toEqual([]);
  });

  it("refuses pid 1 and pid 0 (and a non-integer) before any signal", async () => {
    for (const pid of [1, 0, -5, 2.5, Number.NaN]) {
      const w = setup();
      await expect(
        ptyKill(
          { pid, start: null, exited: w.target.exited },
          { clock: w.clock, warn: w.warn, proc: w.proc, signal: w.signal },
        ),
      ).rejects.toThrow("refusing to signal pid <= 1");
      expect(w.sent).toEqual([]);
    }
  });
});

describe("ptyKill with a process it may not signal, and with late forks", () => {
  it("skips a member that answers EPERM, still hangs up and kills the others, and warns once per step", async () => {
    const w = setup({ deny: [2001] });
    const done = run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS + PTY_EXIT_WAIT_MS);
    await done;
    expect(w.sent).toEqual([
      { at: 0, target: -SHELL, name: "SIGHUP" },
      { at: 0, target: 2002, name: "SIGHUP" },
      { at: PTY_HANGUP_GRACE_MS, target: -SHELL, name: "SIGKILL" },
      { at: PTY_HANGUP_GRACE_MS, target: 2002, name: "SIGKILL" },
    ]);
    expect(w.warn.mock.calls).toEqual([
      ["pty_kill_denied", { pid: SHELL, count: 1 }],
      ["pty_kill_denied", { pid: SHELL, count: 1 }],
      ["pty_kill_timeout", { pid: SHELL }],
    ]);
    expect(w.clock.pending()).toBe(0);
  });

  it("resolves after the exit wait when the shell never exits, EPERM or not, with no timer left", async () => {
    const w = setup({ deny: [2001, 2002] });
    const done = run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS + PTY_EXIT_WAIT_MS);
    await done;
    expect(w.warn).toHaveBeenLastCalledWith("pty_kill_timeout", { pid: SHELL });
    expect(w.clock.pending()).toBe(0);
  });

  it("rethrows an error that is neither ESRCH nor EPERM and leaves no timer armed", async () => {
    const w = setup({
      onSignal: () => {
        throw Object.assign(new Error("bad"), { code: "EINVAL" });
      },
    });
    await expect(run(w)).rejects.toThrow("bad");
    expect(w.clock.pending()).toBe(0);
  });

  it("kills a member that appeared during the first SIGKILL pass on the next pass", async () => {
    let appeared = false;
    const w = setup({
      onSignal: (target, name) => {
        if (name === "SIGKILL" && target === 2001 && !appeared) {
          appeared = true;
          w.table.set(2003, { sid: SHELL, start: "202" });
        }
      },
    });
    const done = run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS);
    expect(w.sent.filter((s) => s.name === "SIGKILL").map((s) => s.target)).toEqual([
      -SHELL,
      2001,
      2002,
      -SHELL,
      2003,
    ]);
    w.exit();
    await done;
  });

  it("stops after 8 SIGKILL passes when members keep appearing", async () => {
    let next = 5000;
    const w = setup({
      onSignal: (_target, name) => {
        if (name === "SIGKILL") w.table.set(next++, { sid: SHELL, start: "900" });
      },
    });
    void run(w);
    await w.clock.advance(PTY_HANGUP_GRACE_MS);
    expect(w.sent.filter((s) => s.name === "SIGKILL" && s.target === -SHELL)).toHaveLength(8);
  });
});

describe("sessionMembers", () => {
  it("lists the other members of the session and not the shell", async () => {
    const w = setup();
    expect(await sessionMembers(w.target, w.proc)).toEqual([2001, 2002]);
  });
  it("answers null for a pid that is another process now, and the list when the shell is gone", async () => {
    expect(await sessionMembers({ ...setup().target, start: "1" }, setup().proc)).toBeNull();
    const w = setup();
    w.table.delete(SHELL);
    expect(await sessionMembers(w.target, w.proc)).toEqual([2001, 2002]);
  });
});

describe("parseProcStat", () => {
  it("reads the session and the start after a command name with spaces and parentheses", () => {
    expect(
      parseProcStat(7, "7 (a) b (c) S 1 7 7 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 123 4 5"),
    ).toEqual({ pid: 7, sid: 7, start: "12345" });
  });
  it("answers null without a closing parenthesis or with garbage fields", () => {
    expect(parseProcStat(7, "7 a b c")).toBeNull();
    expect(parseProcStat(7, "7 (a) S 1 x")).toBeNull();
  });
});
