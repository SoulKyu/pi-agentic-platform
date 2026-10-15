import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { firstLine, type PrecheckDeps, precheckSpec, runPrecheck } from "./precheck.ts";

describe("precheckSpec (M10R69)", () => {
  it("runs the saved command under /bin/sh -c, with no scope", () => {
    expect(precheckSpec("make check", { A: "1" }, null)).toEqual({
      file: "/bin/sh",
      args: ["-c", "make check"],
      env: { A: "1" },
    });
  });

  it("puts the scope's launch in front and adds its runtime directory to the environment", () => {
    const scope = {
      command: "systemd-run",
      args: ["--user", "--scope", "--"],
      env: { XDG_RUNTIME_DIR: "/run/user/1" },
    };
    expect(precheckSpec("make check", { A: "1" }, scope)).toEqual({
      file: "systemd-run",
      args: ["--user", "--scope", "--", "/bin/sh", "-c", "make check"],
      env: { A: "1", XDG_RUNTIME_DIR: "/run/user/1" },
    });
  });
});

describe("firstLine", () => {
  it("takes the first non-empty line and strips bidi, zero-width and control characters", () => {
    expect(firstLine("\n  \n‮nothing \u001B[31mnew​\nsecond")).toBe("nothing [31mnew");
  });

  it("stops at 120 code points", () => {
    expect(firstLine("x".repeat(300))).toHaveLength(120);
  });
});

describe("a shell that SIGKILL does not end (liveness)", () => {
  it("settles timeout after the kill grace, drops the pipes and keeps the group tracked", async () => {
    const clock = createFakeClock();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const signals: string[] = [];
    const release = vi.fn();
    const deps = {
      spawn: (() => child) as unknown as PrecheckDeps["spawn"],
      stdio: () => ["pipe", "pipe", "pipe"],
      now: () => clock.now(),
      setTimer: (fn, ms) => {
        const handle = clock.setTimeout(fn, ms);
        return { cancel: () => clock.clearTimeout(handle) };
      },
      groups: { track: () => {}, signal: (_pid, signal) => void signals.push(signal), release },
    } satisfies PrecheckDeps;
    let outcome: unknown = null;
    void runPrecheck(precheckSpec("hang", {}, null), "/", deps, { timeoutMs: 100 }).then((value) => {
      outcome = value;
    });
    await clock.advance(100);
    expect(signals).toEqual(["SIGTERM"]);
    await clock.advance(2000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome).toBeNull();
    await clock.advance(2000);
    expect(outcome).toMatchObject({ verdict: "error", code: "timeout" });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
});
