import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import type { WorkerExit } from "./exit.ts";

export interface ScopeLimits {
  readonly memoryMaxMb: number;
  readonly tasksMax: number;
  /** Tests only (M2-RT-41): 0 keeps a test's hog from swapping instead of reaching MemoryMax. */
  readonly memorySwapMaxMb?: number;
}
export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
}
export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;
export interface ScopeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
/** One worker's unit: the argv that goes before `node`, and what to do once the worker ran. */
export interface WorkerScope {
  readonly unit: string;
  readonly launch: ScopeLaunch;
  /** At the worker's first record (it runs inside its unit by then): reads the unit's `oom_kill` baseline. Never throws. */
  started(): Promise<void>;
  /**
   * After the worker exited: whether its own death was the memory limit (a SIGKILL while the unit's `oom_kill` rose
   * since `started`, owner R2-1), then the unit's cgroup is SIGKILLed (what Pi started in a group of its own survives
   * the worker otherwise, R100), stopped and its failed state cleared. Never throws.
   */
  reap(exit: Pick<WorkerExit, "signal">): Promise<{ oomKilled: boolean }>;
}
export interface WorkerScopes {
  readonly enabled: boolean;
  /** The slice of this daemon's units: one per PAP_HOME. */
  readonly slice: string | null;
  next(): WorkerScope | null;
  /** At boot: stops what an earlier daemon of this home left in the slice. Never throws. */
  sweep(): Promise<void>;
  /** When a stop is given up: SIGKILLs the whole slice, synchronously, bounded. Never throws. */
  killAllNow(): void;
}

export const NO_SCOPES: WorkerScopes = {
  enabled: false,
  slice: null,
  next: () => null,
  sweep: async () => {},
  killAllNow: () => {},
};
const PROBE_TIMEOUT_MS = 5000;
const SYSTEMCTL_TIMEOUT_MS = 5000;
const KILL_NOW_TIMEOUT_MS = 2000;
/** A scope being stopped by systemd can take a moment to record its result. */
const STOPPING_POLLS = 20;
const STOPPING_POLL_MS = 100;

/** The memory a worker's scope may use (owner R2-1): half the host, at least 2 GiB. */
export const defaultMemoryMaxMb = (totalMemMb: number): number => Math.max(2048, Math.floor(totalMemMb / 2));

/** `app-pap-<h>.slice` and `pap-<h>-worker-…`: `h` names one PAP_HOME, so a daemon only ever sweeps its own units. */
export function sliceNames(home: string): { slice: string; unitPrefix: string } {
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // A home that does not exist yet (tests) is named by its path.
  }
  const h = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return { slice: `app-pap-${h}.slice`, unitPrefix: `pap-${h}-worker-` };
}

export interface ProbeDeps {
  readonly home: string;
  readonly uid: number;
  readonly exec: Exec;
  execSync(file: string, args: readonly string[], timeoutMs: number): number | null;
  readonly env: NodeJS.ProcessEnv;
  which(command: string): string | null;
  readonly clock: Clock;
  readonly logger: Logger;
  readCgroupFile?(controlGroup: string, file: string): string;
}

export function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return values;
}

export function counterOf(text: string, key: string): number {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

// An unreadable counter reads as 0: the worst case is an OOM reported as a plain SIGKILL.
const readCgroup = (group: string, file: string): string => {
  try {
    return readFileSync(join("/sys/fs/cgroup", group, file), "utf8");
  } catch {
    return "";
  }
};

/** Probes once, at boot: a lingering user manager that answers gets one scope per worker; anything else runs workers as in M1. */
export async function probeScopes(
  mode: "auto" | "off",
  limits: ScopeLimits,
  deps: ProbeDeps,
): Promise<WorkerScopes> {
  const off = (reason: string, level: "info" | "warn"): WorkerScopes => {
    deps.logger[level]("worker_scopes", { enabled: false, reason });
    return NO_SCOPES;
  };
  if (mode === "off") return off("PAP_WORKER_SCOPE=off", "info");
  const runtimeDir = deps.env.XDG_RUNTIME_DIR;
  const systemdRun = deps.which("systemd-run");
  const systemctl = deps.which("systemctl");
  const loginctl = deps.which("loginctl");
  if (!runtimeDir || !systemdRun || !systemctl || !loginctl) return off("no systemd user manager", "info");
  const run = (file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> =>
    deps.exec(file, args, timeoutMs).catch(() => ({ code: null, stdout: "" }));
  // Without linger, logind stops the user manager, and every scope with it, when the last login session ends (R2-3).
  const linger = await run(
    loginctl,
    ["show-user", String(deps.uid), "--property=Linger", "--value"],
    PROBE_TIMEOUT_MS,
  );
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
    return off(
      "linger off: scoped workers would stop at logout; `loginctl enable-linger` enables them",
      "warn",
    );
  }
  const probe = async (extra: readonly string[]) =>
    (
      await run(
        systemdRun,
        ["--user", "--scope", "--quiet", "--collect", ...extra, "--", "true"],
        PROBE_TIMEOUT_MS,
      )
    ).code === 0;
  // OOMPolicy on scopes needs systemd 253; an older user manager still gets plain scopes.
  const oomPolicy = await probe(["--property=OOMPolicy=continue"]);
  if (!oomPolicy && !(await probe([]))) return off("systemd-run --user --scope failed", "warn");
  const { slice, unitPrefix } = sliceNames(deps.home);
  deps.logger.info("worker_scopes", { enabled: true, slice, oomPolicy, ...limits });
  const properties = [
    `--property=MemoryMax=${limits.memoryMaxMb}M`,
    `--property=TasksMax=${limits.tasksMax}`,
    ...(limits.memorySwapMaxMb === undefined ? [] : [`--property=MemorySwapMax=${limits.memorySwapMaxMb}M`]),
    // A stop never waits systemd's default 90 s for a process that ignores SIGTERM.
    "--property=TimeoutStopSec=5",
    // A child the kernel kills for memory does not take the worker with it (owner R2-1).
    ...(oomPolicy ? ["--property=OOMPolicy=continue"] : []),
  ];
  // A failed step is logged (unit and step only) and the next step still runs: reap never throws.
  const systemctlRun = async (args: readonly string[]): Promise<ExecResult> => {
    const result = await run(systemctl, ["--user", ...args], SYSTEMCTL_TIMEOUT_MS);
    if (result.code !== 0 && args[0] !== "show" && args[0] !== "reset-failed") {
      deps.logger.warn("worker_scope_step_failed", { step: args[0], unit: args.at(-1), code: result.code });
    }
    return result;
  };
  const cgroupFile = deps.readCgroupFile ?? readCgroup;
  const unitState = async (unit: string) => {
    const shown = await systemctlRun(["show", unit, "--property=ActiveState,Result,ControlGroup"]);
    if (shown.code !== 0) return { group: "", result: null, active: null };
    const state = parseKeyValues(shown.stdout);
    return {
      group: state.get("ControlGroup") ?? "",
      result: state.get("Result") ?? null,
      active: state.get("ActiveState") ?? null,
    };
  };
  // A unit's own cgroup is gone once its last process died (OOMPolicy=continue leaves no failed unit to read), and the
  // slice's counter keeps what its units' kills added: the baseline and the later read both come from the slice.
  const sliceOomKills = (sliceGroup: string): number =>
    counterOf(cgroupFile(sliceGroup, "memory.events"), "oom_kill");
  return {
    enabled: true,
    slice,
    next() {
      const unit = `${unitPrefix}${randomBytes(4).toString("hex")}.scope`;
      let sliceGroup: string | null = null;
      let baseline = 0;
      return {
        unit,
        launch: {
          command: systemdRun,
          args: ["--user", "--scope", "--quiet", `--unit=${unit}`, `--slice=${slice}`, ...properties, "--"],
          // systemd-run reaches the user manager through it; the worker inherits it, as any child of the user would.
          env: { XDG_RUNTIME_DIR: runtimeDir },
        },
        async started() {
          const { group } = await unitState(unit);
          if (!group) return;
          sliceGroup = dirname(group);
          baseline = sliceOomKills(sliceGroup);
        },
        async reap(exit) {
          let oomKilled = false;
          for (let poll = 0; poll < STOPPING_POLLS; poll++) {
            const state = await unitState(unit);
            // Only the worker's own death counts: a child killed earlier left the worker running (owner R2-1).
            // The slice is shared by this home's workers, so a sibling's OOM during this life can also read as one (accepted).
            const rose = sliceGroup !== null && sliceOomKills(sliceGroup) > baseline;
            if (exit.signal === "SIGKILL" && (state.result === "oom-kill" || rose)) oomKilled = true;
            if (state.active !== "deactivating") break;
            await deps.clock.sleep(STOPPING_POLL_MS);
          }
          await systemctlRun(["kill", "--signal=SIGKILL", unit]);
          await systemctlRun(["stop", unit]);
          await systemctlRun(["reset-failed", unit]);
          return { oomKilled };
        },
      };
    },
    async sweep() {
      // One daemon per home (R119): whatever is in this slice was left by an earlier daemon of this home.
      const stopped = await run(systemctl, ["--user", "stop", slice], SYSTEMCTL_TIMEOUT_MS);
      const cleared = await run(
        systemctl,
        ["--user", "reset-failed", `${unitPrefix}*`],
        SYSTEMCTL_TIMEOUT_MS,
      );
      deps.logger.info("worker_scopes_swept", { slice, stop: stopped.code, resetFailed: cleared.code });
    },
    killAllNow() {
      const code = deps.execSync(
        systemctl,
        ["--user", "kill", "--signal=SIGKILL", slice],
        KILL_NOW_TIMEOUT_MS,
      );
      if (code !== 0) deps.logger.warn("worker_scopes_kill_failed", { slice, code });
    },
  };
}
