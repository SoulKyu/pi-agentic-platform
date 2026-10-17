import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import {
  createSandboxProbe,
  PROBE_TIMEOUT_MS,
  probeSandbox,
  type SandboxProbe,
  trustedBinary,
  type TrustOps,
} from "./probe.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pap-probe-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

const lastArg = (calls: Array<{ args: string[] }>): string => calls[0]?.args.at(-1) ?? "";
const missingResult: SandboxProbe = { usable: false, reason: "missing" };
const left = (): string[] => readdirSync(work).filter((name) => name.startsWith("pap-probe-"));

describe("trustedBinary", () => {
  it("returns the real path of a root-owned system binary", () => {
    expect(trustedBinary("/usr/bin/bwrap")).toBe(realpathSync("/usr/bin/bwrap"));
    expect(trustedBinary("/bin/sh")).toBe(realpathSync("/bin/sh"));
    expect(trustedBinary("/bin/sh")?.startsWith("/usr/bin/")).toBe(true);
  });

  it("refuses a file the test user owns, a relative path, a missing file, a directory, a NUL", () => {
    const copy = join(work, "bwrap");
    copyFileSync("/usr/bin/bwrap", copy);
    expect(trustedBinary(copy)).toBeNull();
    expect(trustedBinary("usr/bin/bwrap")).toBeNull();
    expect(trustedBinary("/usr/bin/pap-no-such-binary")).toBeNull();
    expect(trustedBinary("/usr/bin")).toBeNull();
    expect(trustedBinary("/usr/bin/bwrap\0")).toBeNull();
  });

  it("judges the real path of a link in a user folder, not the link", () => {
    const link = join(work, "bwrap-link");
    symlinkSync("/usr/bin/bwrap", link);
    expect(trustedBinary(link)).toBe(realpathSync("/usr/bin/bwrap"));
  });

  describe("every folder above the file (fake file system)", () => {
    type Entry = { uid: number; mode: number; file?: boolean };
    const tree = (overrides: Record<string, Partial<Entry>> = {}): TrustOps => {
      const entries: Record<string, Entry> = {
        "/": { uid: 0, mode: 0o755 },
        "/opt": { uid: 0, mode: 0o755 },
        "/opt/tools": { uid: 0, mode: 0o755 },
        "/opt/tools/bwrap": { uid: 0, mode: 0o755, file: true },
      };
      for (const [path, change] of Object.entries(overrides))
        entries[path] = { uid: 0, mode: 0o755, ...entries[path], ...change };
      return {
        realpath: (path) => path,
        stat: (path) => {
          const entry = entries[path];
          if (entry === undefined) throw new Error("ENOENT");
          return { uid: entry.uid, mode: entry.mode, isFile: () => entry.file === true };
        },
      };
    };

    it("accepts a root-owned chain", () => {
      expect(trustedBinary("/opt/tools/bwrap", tree())).toBe("/opt/tools/bwrap");
    });

    it.each([
      ["a folder owned by a user", { "/opt/tools": { uid: 1000 } }],
      ["a folder writable by its group", { "/opt/tools": { mode: 0o775 } }],
      ["a folder writable by anyone", { "/opt": { mode: 0o777 } }],
      ["a root folder owned by a user", { "/": { uid: 1000 } }],
      ["a file owned by a user", { "/opt/tools/bwrap": { uid: 1000 } }],
      ["a file writable by its group", { "/opt/tools/bwrap": { mode: 0o775 } }],
      ["a file nobody may execute", { "/opt/tools/bwrap": { mode: 0o644 } }],
    ])("refuses %s", (_name, overrides) => {
      expect(trustedBinary("/opt/tools/bwrap", tree(overrides))).toBeNull();
    });

    it("refuses when a folder above cannot be read (fail closed)", () => {
      const ops = tree();
      expect(
        trustedBinary("/opt/tools/bwrap", {
          ...ops,
          stat: (path) => {
            if (path === "/opt") throw new Error("EACCES");
            return ops.stat(path);
          },
        }),
      ).toBeNull();
    });
  });
});

describe("probeSandbox, before anything runs", () => {
  it("a user-owned copy is unsafe_path, a name PATH could find is missing", async () => {
    const copy = join(work, "bwrap");
    copyFileSync("/usr/bin/bwrap", copy);
    const deps = { timers: createFakeClock(), tmp: work };
    expect(await probeSandbox(copy, deps)).toEqual({ usable: false, reason: "unsafe_path" });
    expect(await probeSandbox("bwrap", deps)).toEqual({ usable: false, reason: "missing" });
    expect(await probeSandbox(join(work, "nothing"), deps)).toEqual({ usable: false, reason: "missing" });
    expect(left()).toEqual([]);
  });

  it("a root binary that does not sandbox is refused: false, true, echo (no nonce alone)", async () => {
    for (const binary of ["/usr/bin/false", "/usr/bin/true", "/usr/bin/echo"]) {
      expect(await probeSandbox(binary, { timers: createFakeClock(), tmp: work }), binary).toEqual({
        usable: false,
        reason: "refused",
      });
      expect(left()).toEqual([]);
    }
  });
});

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
}
const fakeChild = (pid = 424_242): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  return child;
};

describe("probeSandbox, with an injected spawn", () => {
  const run = (child: FakeChild, clock: FakeClock = createFakeClock()) => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return child;
    }) as never;
    return { calls, result: probeSandbox("/usr/bin/true", { timers: clock, spawn, tmp: work }), clock };
  };

  it("spawns with an empty environment, captured stdout, a group, and the nonce as the last argument", async () => {
    const child = fakeChild();
    const { calls, result } = run(child);
    const nonce = lastArg(calls);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0]?.options).toEqual({ env: {}, stdio: ["ignore", "pipe", "ignore"], detached: true });
    expect(calls[0]?.command).toBe(realpathSync("/usr/bin/true"));
    child.stdout.emit("data", Buffer.from(`${nonce}\n`));
    child.emit("close", 0);
    expect(await result).toEqual({ usable: true, path: realpathSync("/usr/bin/true") });
    expect(left()).toEqual([]);
  });

  it.each([
    ["the nonce with a failing exit", (nonce: string) => ({ out: nonce, code: 1 })],
    ["a wrong word, exit 0", () => ({ out: "ok", code: 0 })],
    ["no output, exit 0", () => ({ out: "", code: 0 })],
    ["the nonce among other text", (nonce: string) => ({ out: `x ${nonce}`, code: 0 })],
  ])("is refused for %s", async (_name, answer) => {
    const child = fakeChild();
    const { calls, result } = run(child);
    const { out, code } = answer(lastArg(calls));
    if (out) child.stdout.emit("data", Buffer.from(out));
    child.emit("close", code);
    expect(await result).toEqual({ usable: false, reason: "refused" });
    expect(left()).toEqual([]);
  });

  it("is refused when the spawn fails, asynchronously or at once", async () => {
    const child = fakeChild();
    const { result } = run(child);
    child.emit("error", new Error("EACCES"));
    expect(await result).toEqual({ usable: false, reason: "refused" });
    expect(left()).toEqual([]);
    const throwing = probeSandbox("/usr/bin/true", {
      timers: createFakeClock(),
      tmp: work,
      spawn: (() => {
        throw new Error("EAGAIN");
      }) as never,
    });
    expect(await throwing).toEqual({ usable: false, reason: "refused" });
    expect(left()).toEqual([]);
  });

  it("times out at 5 s on the injected clock, kills the group (pid > 1) and removes the canary", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const clock = createFakeClock();
    const child = fakeChild(424_242);
    const { result } = run(child, clock);
    expect(left()).toHaveLength(1);
    await clock.advance(PROBE_TIMEOUT_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(await result).toEqual({ usable: false, reason: "timeout" });
    expect(kill).toHaveBeenCalledWith(-424_242, "SIGKILL");
    expect(left()).toEqual([]);
    child.emit("close", 0);
    expect(clock.pending()).toBe(0);
  });

  it("never signals a group for a pid of 1 or less, and a late close does not change the answer", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const clock = createFakeClock();
    const child = fakeChild(1);
    const { result } = run(child, clock);
    await clock.advance(PROBE_TIMEOUT_MS);
    expect(await result).toEqual({ usable: false, reason: "timeout" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops reading stdout at 256 bytes: a nonce behind 300 blanks is not an answer", async () => {
    const child = fakeChild();
    const { calls, result } = run(child);
    child.stdout.emit("data", Buffer.from(`${" ".repeat(300)}${lastArg(calls)}\n`));
    child.emit("close", 0);
    expect(await result).toEqual({ usable: false, reason: "refused" });
  });

  it("ends even when the canary folder cannot be removed, and says so once", async () => {
    const warned: string[] = [];
    const logger = { warn: (msg: string) => void warned.push(msg) } as unknown as Logger;
    const child = fakeChild();
    const spawn = (() => {
      chmodSync(work, 0o500);
      return child;
    }) as never;
    const result = probeSandbox("/usr/bin/true", { timers: createFakeClock(), spawn, tmp: work, logger });
    child.emit("close", 1);
    try {
      expect(await result).toEqual({ usable: false, reason: "refused" });
    } finally {
      chmodSync(work, 0o700);
    }
    expect(warned).toEqual(["sandbox_probe_cleanup_failed"]);
  });

  it("clears its timer when the child ends first", async () => {
    const clock = createFakeClock();
    const child = fakeChild();
    const { result } = run(child, clock);
    child.emit("close", 1);
    await result;
    expect(clock.pending()).toBe(0);
  });
});

describe("createSandboxProbe", () => {
  const logger = (lines: Array<{ msg: string; fields?: unknown }>): Logger => {
    const log: Logger = {
      debug: () => undefined,
      info: (msg, fields) => void lines.push({ msg, fields }),
      warn: () => undefined,
      error: () => undefined,
      child: () => log,
    };
    return log;
  };
  const make = (results: SandboxProbe[]) => {
    const clock = createFakeClock();
    const lines: Array<{ msg: string; fields?: unknown }> = [];
    const calls: Array<string | undefined> = [];
    const probe = createSandboxProbe({
      override: "/x/bwrap",
      clock,
      logger: logger(lines),
      probe: (override) => {
        calls.push(override);
        return Promise.resolve(results[Math.min(calls.length, results.length) - 1] ?? missingResult);
      },
    });
    return { clock, lines, calls, probe };
  };
  const missing: SandboxProbe = { usable: false, reason: "missing" };
  const usable: SandboxProbe = { usable: true, path: "/usr/bin/bwrap" };

  it("is not usable before the first probe, and passes the override to the probe", async () => {
    const { probe, calls } = make([usable]);
    expect(probe.current()).toMatchObject({ usable: false });
    await probe.recheck();
    expect(calls).toEqual(["/x/bwrap"]);
    expect(probe.current()).toEqual({ usable: true, path: "/usr/bin/bwrap", checkedAt: 1_700_000_000_000 });
  });

  it("logs one line per change, not per probe", async () => {
    const { probe, lines } = make([missing, missing, usable, usable]);
    await probe.recheck();
    await probe.recheck();
    await probe.recheck();
    await probe.recheck();
    expect(lines).toEqual([
      { msg: "sandbox_probe", fields: { usable: false, reason: "missing" } },
      { msg: "sandbox_probe", fields: { usable: true, reason: null } },
    ]);
  });

  it("ensure keeps a usable result without probing again", async () => {
    const { probe, calls, clock } = make([usable, missing]);
    await probe.recheck();
    await clock.advance(10 * 60_000);
    expect(await probe.ensure()).toEqual({ usable: true, path: "/usr/bin/bwrap" });
    expect(calls).toHaveLength(1);
  });

  it("ensure checks a usable binary again at each call: one removed or swapped after boot is probed afresh", async () => {
    let trusted: string | null = "/usr/bin/bwrap";
    const clock = createFakeClock();
    const calls: Array<string | undefined> = [];
    const probe = createSandboxProbe({
      override: undefined,
      clock,
      logger: logger([]),
      probe: () => {
        calls.push("probe");
        return Promise.resolve(calls.length === 1 ? usable : missing);
      },
      trusted: () => trusted,
    });
    await probe.recheck();
    expect(await probe.ensure()).toEqual(usable);
    expect(calls).toHaveLength(1);
    trusted = null; // the binary is gone, or a folder on its way is no longer root's
    expect(await probe.ensure()).toEqual(missing);
    expect(calls).toHaveLength(2);
    expect(probe.current()).toMatchObject({ usable: false, reason: "missing" });
  });

  it("ensure re-probes a failure only once it is older than 60 s", async () => {
    const { probe, calls, clock } = make([missing, usable]);
    await probe.recheck();
    await clock.advance(60_000);
    expect(await probe.ensure()).toEqual(missing);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(await probe.ensure()).toEqual(usable);
    expect(calls).toHaveLength(2);
  });

  it("ensure probes at once when nothing was probed yet", async () => {
    const { probe, calls } = make([usable]);
    expect(await probe.ensure()).toEqual(usable);
    expect(calls).toHaveLength(1);
  });

  it("one probe at a time: concurrent rechecks share it", async () => {
    const { probe, calls } = make([usable]);
    const [a, b] = await Promise.all([probe.recheck(), probe.recheck()]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("a probe that throws is a refusal, never an exception", async () => {
    const clock = createFakeClock();
    const probe = createSandboxProbe({
      override: undefined,
      clock,
      logger: logger([]),
      probe: () => Promise.reject(new Error("boom")),
    });
    expect(await probe.recheck()).toEqual({ usable: false, reason: "refused" });
  });
});
