import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger, silentLogger } from "../logger.ts";
import { defaultMemoryMaxMb, type Exec, NO_SCOPES, probeScopes, sliceNames } from "./scope.ts";

const LIMITS = { memoryMaxMb: 2048, tasksMax: 4096 };
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };
const HOME = "/nonexistent/pap-home";
const { slice: SLICE, unitPrefix: PREFIX } = sliceNames(HOME);

type Answer = { code: number | null; stdout?: string };
function fakeExec(answers: (file: string, args: readonly string[]) => Answer) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers(file, args);
    return { code: answer.code, stdout: answer.stdout ?? "" };
  };
  return { exec, calls };
}
// A lingering user manager where systemd-run works.
const healthy = (file: string, args: readonly string[]): Answer =>
  file.endsWith("loginctl")
    ? { code: 0, stdout: "yes\n" }
    : args[1] === "show"
      ? { code: 0, stdout: "ActiveState=active\nResult=success\nControlGroup=/u/x.scope\n" }
      : { code: 0 };
const which = (command: string) => `/usr/bin/${command}`;
const deps = (exec: Exec, extra: Record<string, unknown> = {}) => ({
  home: HOME,
  uid: 1000,
  exec,
  execSync: () => 0,
  env: ENV,
  which,
  clock: createFakeClock(),
  logger: silentLogger,
  ...extra,
});

describe("probeScopes", () => {
  it("is off when asked, without a user manager, when linger is off, or when systemd-run fails", async () => {
    const { exec } = fakeExec(healthy);
    expect(await probeScopes("off", LIMITS, deps(exec))).toBe(NO_SCOPES);
    expect((await probeScopes("auto", LIMITS, deps(exec, { env: {} }))).enabled).toBe(false);
    expect((await probeScopes("auto", LIMITS, deps(exec, { which: () => null }))).enabled).toBe(false);
    const noLinger = fakeExec((file, args) =>
      file.endsWith("loginctl") ? { code: 0, stdout: "no\n" } : healthy(file, args),
    );
    expect((await probeScopes("auto", LIMITS, deps(noLinger.exec))).enabled).toBe(false);
    expect(noLinger.calls.some((call) => call[0]?.endsWith("systemd-run"))).toBe(false);
    const failing = fakeExec((file, args) =>
      file.endsWith("systemd-run") ? { code: 1 } : healthy(file, args),
    );
    expect((await probeScopes("auto", LIMITS, deps(failing.exec))).enabled).toBe(false);
  });

  it("warns once at boot when linger is off (owner R2-3)", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const clock = createFakeClock();
    const logger = createLogger({
      level: "debug",
      clock,
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const { exec } = fakeExec((file, args) =>
      file.endsWith("loginctl") ? { code: 0, stdout: "no\n" } : healthy(file, args),
    );
    await probeScopes("auto", LIMITS, deps(exec, { clock, logger }));
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "worker_scopes",
        enabled: false,
        reason: expect.stringContaining("loginctl enable-linger"),
      }),
    ]);
  });

  it("wraps a worker in a unit of this home's slice, with MemoryMax, TasksMax and OOMPolicy=continue, never MemoryHigh", async () => {
    const { exec } = fakeExec(healthy);
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    const next = scopes.next();
    expect(scopes.slice).toBe(SLICE);
    expect(next?.unit).toMatch(new RegExp(`^${PREFIX}[0-9a-f]{8}\\.scope$`));
    expect(next?.launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        `--unit=${next?.unit}`,
        `--slice=${SLICE}`,
        "--property=MemoryMax=2048M",
        "--property=TasksMax=4096",
        "--property=TimeoutStopSec=5",
        "--property=OOMPolicy=continue",
        "--",
      ],
      env: ENV,
    });
  });

  it("passes MemorySwapMax only when the limits ask for it (tests, M2-RT-41), and OOMPolicy only where systemd knows it", async () => {
    const { exec } = fakeExec(healthy);
    const withSwap = await probeScopes("auto", { ...LIMITS, memorySwapMaxMb: 0 }, deps(exec));
    expect(withSwap.next()?.launch.args).toContain("--property=MemorySwapMax=0M");
    const older = fakeExec((file, args) =>
      args.includes("--property=OOMPolicy=continue") ? { code: 1 } : healthy(file, args),
    );
    expect((await probeScopes("auto", LIMITS, deps(older.exec))).next()?.launch.args).not.toContain(
      "--property=OOMPolicy=continue",
    );
  });

  it("names the slice per PAP_HOME and sizes MemoryMax from the host's memory", () => {
    expect(sliceNames("/a/.pap").slice).toMatch(/^app-pap-[0-9a-f]{8}\.slice$/);
    expect(sliceNames("/a/.pap").unitPrefix).toMatch(/^pap-[0-9a-f]{8}-worker-$/);
    expect(sliceNames("/a/.pap").slice).not.toBe(sliceNames("/b/.pap").slice);
    expect(sliceNames("/a/.pap")).toEqual(sliceNames("/a/.pap"));
    expect([defaultMemoryMaxMb(1024), defaultMemoryMaxMb(4096), defaultMemoryMaxMb(16_384)]).toEqual([
      2048, 2048, 8192,
    ]);
  });

  it("reaps: kills what is left, stops and clears the unit", async () => {
    const { exec, calls } = fakeExec(healthy);
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    calls.length = 0;
    expect(await scope?.reap({ signal: null })).toEqual({ oomKilled: false });
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["--user", "show"],
      ["--user", "kill"],
      ["--user", "stop"],
      ["--user", "reset-failed"],
    ]);
    expect(calls[1]).toContain("--signal=SIGKILL");
  });

  it.each([
    [{ signal: "SIGKILL" as const }, 1, true],
    [{ signal: "SIGKILL" as const }, 0, false],
    [{ signal: null }, 1, false],
  ])(
    "says oom for an exit %j only when the worker was SIGKILLed and oom_kill rose (+%i) during its life",
    async (exit, rise, expected) => {
      let kills = 2;
      const { exec } = fakeExec(healthy);
      const scope = (
        await probeScopes("auto", LIMITS, deps(exec, { readCgroupFile: () => `oom 0\noom_kill ${kills}\n` }))
      ).next();
      await scope?.started();
      kills += rise;
      expect(await scope?.reap(exit)).toEqual({ oomKilled: expected });
    },
  );

  it("never throws when systemctl fails", async () => {
    const exec: Exec = async (file, args) => {
      if (file.endsWith("loginctl")) return { code: 0, stdout: "yes" };
      if (args.includes("true")) return { code: 0, stdout: "" };
      throw new Error(`${file} gone`);
    };
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    await expect(scope?.started()).resolves.toBeUndefined();
    expect(await scope?.reap({ signal: "SIGKILL" })).toEqual({ oomKilled: false });
  });

  it("sweeps its own slice at boot and kills it at once on a forced exit", async () => {
    const { exec, calls } = fakeExec(healthy);
    const killed: string[][] = [];
    const execSync = (file: string, args: readonly string[]) => {
      killed.push([file, ...args]);
      return 0;
    };
    const scopes = await probeScopes("auto", LIMITS, deps(exec, { execSync }));
    calls.length = 0;
    await scopes.sweep();
    expect(calls).toEqual([
      ["/usr/bin/systemctl", "--user", "stop", SLICE],
      ["/usr/bin/systemctl", "--user", "reset-failed", `${PREFIX}*`],
    ]);
    scopes.killAllNow();
    expect(killed).toEqual([["/usr/bin/systemctl", "--user", "kill", "--signal=SIGKILL", SLICE]]);
  });
});
