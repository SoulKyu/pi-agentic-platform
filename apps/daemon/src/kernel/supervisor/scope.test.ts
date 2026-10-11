import { describe, expect, it, vi } from "vitest";
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
type Fields = Record<string, string>;
// `systemctl --user show <name>… --property=…` answers one block per name, in the order asked.
const blocks = (args: readonly string[], state: (name: string) => Fields): string =>
  args
    .slice(2)
    .filter((arg) => !arg.startsWith("--"))
    .map((name) =>
      Object.entries(state(name))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    )
    .join("\n\n")
    .concat("\n");
const alive = (name: string): Fields =>
  name.endsWith(".scope")
    ? { ActiveState: "active", LoadState: "loaded", Result: "success", ControlGroup: "/u/x.scope" }
    : { ActiveState: "active", LoadState: "loaded", Result: "success", ControlGroup: "/u" };
const gone: Fields = { ActiveState: "inactive", LoadState: "not-found", Result: "success", ControlGroup: "" };
// A lingering user manager where systemd-run works.
const withState =
  (state: (name: string) => Fields) =>
  (file: string, args: readonly string[]): Answer =>
    file.endsWith("loginctl")
      ? { code: 0, stdout: "yes\n" }
      : args[1] === "show"
        ? { code: 0, stdout: blocks(args, state) }
        : { code: 0 };
const healthy = withState(alive);
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
function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const clock = createFakeClock();
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, clock, logger };
}
const steps = (calls: string[][]) => calls.map((call) => call.slice(2, 3).concat(call.at(-1) ?? ""));
const SLICE_BASE = SLICE.replace(/\.slice$/, "");

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

  it.each([
    [
      "linger is off",
      (file: string) => (file.endsWith("loginctl") ? { code: 0, stdout: "no\n" } : null),
      undefined,
    ],
    [
      "loginctl is missing",
      () => null,
      (command: string) => (command === "loginctl" ? null : which(command)),
    ],
  ])("warns once at boot when %s (owner R2-3, M2R30)", async (_name, answer, whichOverride) => {
    const { lines, clock, logger } = capture();
    const { exec } = fakeExec((file, args) => answer(file) ?? healthy(file, args));
    await probeScopes(
      "auto",
      LIMITS,
      deps(exec, { clock, logger, ...(whichOverride ? { which: whichOverride } : {}) }),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "worker_scopes",
        enabled: false,
        reason: expect.stringContaining("loginctl enable-linger"),
      }),
    ]);
  });

  it("probes in this home's slice with the real limits, and says so when OOMPolicy is not known", async () => {
    const { lines, clock, logger } = capture();
    const older = fakeExec((file, args) =>
      args.includes("--property=OOMPolicy=continue") ? { code: 1 } : healthy(file, args),
    );
    await probeScopes("auto", LIMITS, deps(older.exec, { clock, logger }));
    const probes = older.calls.filter((call) => call.includes("true"));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe).toContain(`--slice=${SLICE}`);
      expect(probe).toContain("--property=MemoryMax=2048M");
      expect(probe.some((arg) => arg.startsWith("--unit="))).toBe(false);
    }
    expect(probes[0]).toContain("--property=OOMPolicy=continue");
    expect(probes[1]).not.toContain("--property=OOMPolicy=continue");
    expect(
      lines.filter((line) => line.level === "warn" && line.msg === "worker_scopes_oom_policy_missing"),
    ).toHaveLength(1);
  });

  it("wraps a worker in a unit of a slice of its own under this home's slice, with MemoryMax, TasksMax and OOMPolicy=continue, never MemoryHigh", async () => {
    const { exec } = fakeExec(healthy);
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    const next = scopes.next();
    expect(scopes.slice).toBe(SLICE);
    expect(next?.unit).toMatch(new RegExp(`^${PREFIX}[0-9a-f]{8}-1\\.scope$`));
    const slice = next?.launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length);
    expect(slice).toMatch(new RegExp(`^${SLICE_BASE}-[0-9a-f]{8}1\\.slice$`));
    expect(next?.launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        `--unit=${next?.unit}`,
        `--slice=${slice}`,
        "--property=MemoryMax=2048M",
        "--property=TasksMax=4096",
        "--property=TimeoutStopSec=5",
        "--property=OOMPolicy=continue",
        "--",
      ],
      env: ENV,
    });
  });

  it("numbers the units of one probe, so two names never meet by luck", async () => {
    const scopes = await probeScopes("auto", LIMITS, deps(fakeExec(healthy).exec));
    const [one, two, three] = [scopes.next(), scopes.next(), scopes.next()];
    expect(
      [one?.unit, two?.unit, three?.unit].map((unit) => /-([0-9a-f]+)\.scope$/.exec(unit ?? "")?.[1]),
    ).toEqual(["1", "2", "3"]);
    expect(new Set([one?.launch.args[3], two?.launch.args[3], three?.launch.args[3]]).size).toBe(3);
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

  it("reaps: reads the worker's slice, kills what is left, stops and clears the unit, stops the slice", async () => {
    const { exec, calls } = fakeExec(healthy);
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    const slice = scope?.launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length);
    calls.length = 0;
    expect(await scope?.reap({ signal: null })).toEqual({ oomKilled: false });
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["--user", "show"],
      ["--user", "kill"],
      ["--user", "stop"],
      ["--user", "reset-failed"],
      ["--user", "stop"],
    ]);
    expect(calls[0]?.slice(3, 5)).toEqual([scope?.unit, slice]);
    expect(calls[1]).toEqual(["/usr/bin/systemctl", "--user", "kill", "--signal=SIGKILL", scope?.unit]);
    expect(calls[4]).toEqual(["/usr/bin/systemctl", "--user", "stop", slice]);
  });

  it("leaves a unit that is already collected alone, without a warning (I2)", async () => {
    const { lines, clock, logger } = capture();
    const unitGone = fakeExec(withState((name) => (name.endsWith(".scope") ? gone : alive(name))));
    const scope = (await probeScopes("auto", LIMITS, deps(unitGone.exec, { clock, logger }))).next();
    unitGone.calls.length = 0;
    await scope?.reap({ signal: null });
    expect(steps(unitGone.calls).map(([step]) => step)).toEqual(["show", "stop"]);
    const bothGone = fakeExec(withState(() => gone));
    const other = (await probeScopes("auto", LIMITS, deps(bothGone.exec, { clock, logger }))).next();
    bothGone.calls.length = 0;
    await other?.reap({ signal: null });
    expect(steps(bothGone.calls).map(([step]) => step)).toEqual(["show"]);
    expect(lines.filter((line) => line.level === "warn")).toEqual([]);
  });

  it("logs a failing show with a stable code and still cleans up", async () => {
    const { lines, clock, logger } = capture();
    const { exec, calls } = fakeExec((file, args) =>
      args[1] === "show" ? { code: 1 } : healthy(file, args),
    );
    const scope = (await probeScopes("auto", LIMITS, deps(exec, { clock, logger }))).next();
    calls.length = 0;
    expect(await scope?.reap({ signal: "SIGKILL" })).toEqual({ oomKilled: false });
    expect(calls.map((call) => call[2])).toEqual(["show", "kill", "stop", "reset-failed", "stop"]);
    expect(lines.filter((line) => line.msg === "worker_scope_show_failed")).toEqual([
      expect.objectContaining({ level: "warn", unit: scope?.unit, code: 1 }),
    ]);
    // One line for the failed show, not a second generic step line whose `unit` is the `--property=…` argument.
    expect(lines.filter((line) => String(line.msg).startsWith("worker_scope_"))).toHaveLength(1);
  });

  it.each([
    [{ signal: "SIGKILL" as const }, 1, true],
    [{ signal: "SIGKILL" as const }, 0, false],
    [{ signal: null }, 1, false],
  ])(
    "says oom for an exit %j only when the worker was SIGKILLed and its own slice counted oom_kill (%i)",
    async (exit, kills, expected) => {
      const readCgroupFile = (group: string, file: string) =>
        group === "/u" && file === "memory.events" ? `oom 0\noom_kill ${kills}\n` : "oom_kill 99\n";
      const { exec } = fakeExec(healthy);
      const scope = (await probeScopes("auto", LIMITS, deps(exec, { readCgroupFile }))).next();
      expect(await scope?.reap(exit)).toEqual({ oomKilled: expected });
    },
  );

  it("says oom when systemd itself says Result=oom-kill for a SIGKILLed worker", async () => {
    const { exec } = fakeExec(withState((name) => ({ ...alive(name), Result: "oom-kill" })));
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    expect(await scope?.reap({ signal: "SIGKILL" })).toEqual({ oomKilled: true });
    expect(await scope?.reap({ signal: null })).toEqual({ oomKilled: false });
  });

  it("waits while the unit is deactivating, then cleans up", async () => {
    const clock = createFakeClock();
    let deactivating = 3;
    const { exec, calls } = fakeExec(
      withState((name) =>
        name.endsWith(".scope") && deactivating-- > 0
          ? { ...alive(name), ActiveState: "deactivating" }
          : alive(name),
      ),
    );
    const scope = (await probeScopes("auto", LIMITS, deps(exec, { clock }))).next();
    calls.length = 0;
    let done = false;
    void scope?.reap({ signal: null }).then(() => (done = true));
    for (let tick = 0; tick < 2; tick++) {
      await clock.advance(100);
      expect(done).toBe(false);
    }
    await clock.advance(100);
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 1000 });
    expect(calls.filter((call) => call[2] === "show")).toHaveLength(4);
    expect(calls.some((call) => call[2] === "kill")).toBe(true);
  });

  it("gives up waiting for a deactivating unit after 20 reads and cleans up anyway", async () => {
    const clock = createFakeClock();
    const { exec, calls } = fakeExec(
      withState((name) => ({
        ...alive(name),
        ActiveState: name.endsWith(".scope") ? "deactivating" : "active",
      })),
    );
    const scope = (await probeScopes("auto", LIMITS, deps(exec, { clock }))).next();
    calls.length = 0;
    let done = false;
    void scope?.reap({ signal: null }).then(() => (done = true));
    for (let tick = 0; tick < 25; tick++) await clock.advance(100);
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 1000 });
    expect(calls.filter((call) => call[2] === "show")).toHaveLength(20);
    expect(calls.some((call) => call[2] === "kill")).toBe(true);
  });

  it("never throws when systemctl fails", async () => {
    const exec: Exec = async (file, args) => {
      if (file.endsWith("loginctl")) return { code: 0, stdout: "yes" };
      if (args.includes("true")) return { code: 0, stdout: "" };
      throw new Error(`${file} gone`);
    };
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
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
