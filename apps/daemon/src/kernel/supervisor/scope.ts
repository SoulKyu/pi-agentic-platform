import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
/** One worker's unit and the slice of its own it runs in: the argv that goes before `node`, and what to do once the worker ran. */
export interface WorkerScope {
  readonly unit: string;
  readonly launch: ScopeLaunch;
  /**
   * After the worker exited: whether its own death was the memory limit (a SIGKILL while its slice's `oom_kill`
   * counted something, owner R2-1: the slice is born at spawn and holds this worker only, so the counter needs no
   * baseline), then the unit's cgroup is SIGKILLed (what Pi started in a group of its own survives the worker
   * otherwise, R100), the unit stopped and cleared, and the worker's slice stopped. Never throws.
   */
  reap(exit: Pick<WorkerExit, "signal">): Promise<{ oomKilled: boolean }>;
}
export interface WorkerScopes {
  readonly enabled: boolean;
  /** The slice of this daemon's units: one per PAP_HOME. Each worker's own slice is nested in it (`<slice>-<id>.slice`). */
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
  if (!runtimeDir || !systemdRun || !systemctl) return off("no systemd user manager", "info");
  // Without linger, logind stops the user manager, and every scope with it, when the last login session ends (R2-3).
  const lingerReason =
    "linger off: scoped workers would stop at logout; `loginctl enable-linger` enables them";
  if (!loginctl) return off(lingerReason, "warn");
  const run = (file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> =>
    deps.exec(file, args, timeoutMs).catch(() => ({ code: null, stdout: "" }));
  const linger = await run(
    loginctl,
    ["show-user", String(deps.uid), "--property=Linger", "--value"],
    PROBE_TIMEOUT_MS,
  );
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") return off(lingerReason, "warn");
  const { slice, unitPrefix } = sliceNames(deps.home);
  const sliceBase = slice.replace(/\.slice$/, "");
  const properties = [
    `--property=MemoryMax=${limits.memoryMaxMb}M`,
    `--property=TasksMax=${limits.tasksMax}`,
    ...(limits.memorySwapMaxMb === undefined ? [] : [`--property=MemorySwapMax=${limits.memorySwapMaxMb}M`]),
    // A stop never waits systemd's default 90 s for a process that ignores SIGTERM.
    "--property=TimeoutStopSec=5",
  ];
  const oomPolicyProperty = "--property=OOMPolicy=continue";
  // The probe is a worker in miniature: this home's slice, the real limits, so what it proves is what workers get.
  const probe = async (extra: readonly string[]) =>
    (
      await run(
        systemdRun,
        [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${slice}`,
          ...properties,
          ...extra,
          "--",
          "true",
        ],
        PROBE_TIMEOUT_MS,
      )
    ).code === 0;
  // OOMPolicy on scopes needs systemd 253; an older user manager still gets plain scopes.
  const oomPolicy = await probe([oomPolicyProperty]);
  if (!oomPolicy) {
    if (!(await probe([]))) return off("systemd-run --user --scope failed", "warn");
    deps.logger.warn("worker_scopes_oom_policy_missing", { slice });
  }
  deps.logger.info("worker_scopes", { enabled: true, slice, oomPolicy, ...limits });
  // A failed step is logged (unit and step only) and the next step still runs: reap never throws.
  const systemctlRun = async (args: readonly string[]): Promise<ExecResult> => {
    const result = await run(systemctl, ["--user", ...args], SYSTEMCTL_TIMEOUT_MS);
    if (result.code !== 0 && args[0] !== "reset-failed" && args[0] !== "show") {
      deps.logger.warn("worker_scope_step_failed", { step: args[0], unit: args.at(-1), code: result.code });
    }
    return result;
  };
  const cgroupFile = deps.readCgroupFile ?? readCgroup;
  // The unit and its slice in one call (one block each, in the order asked). A unit that already ended is collected
  // by systemd (`LoadState=not-found`): there is nothing left to kill or stop, and a step on it would only fail.
  const showState = async (unit: string, workerSlice: string) => {
    const shown = await systemctlRun([
      "show",
      unit,
      workerSlice,
      "--property=ActiveState,LoadState,Result,ControlGroup",
    ]);
    if (shown.code !== 0) {
      deps.logger.warn("worker_scope_show_failed", { unit, code: shown.code });
      return null;
    }
    const [unitBlock, sliceBlock] = shown.stdout.trim().split(/\n\n+/).map(parseKeyValues);
    return { unit: unitBlock ?? new Map<string, string>(), slice: sliceBlock ?? new Map<string, string>() };
  };
  let counter = 0;
  return {
    enabled: true,
    slice,
    next() {
      // The counter is part of the name: two workers of one probe never meet by luck of the random part.
      const id = `${randomBytes(4).toString("hex")}`;
      counter++;
      const unit = `${unitPrefix}${id}-${counter}.scope`;
      // Not `<slice>-<id>-<n>`: a dash is a level of hierarchy, and one level (under this home's slice) is all that is wanted.
      const workerSlice = `${sliceBase}-${id}${counter.toString(16)}.slice`;
      return {
        unit,
        launch: {
          command: systemdRun,
          args: [
            "--user",
            "--scope",
            "--quiet",
            `--unit=${unit}`,
            `--slice=${workerSlice}`,
            ...properties,
            ...(oomPolicy ? [oomPolicyProperty] : []),
            "--",
          ],
          // systemd-run reaches the user manager through it; the worker inherits it, as any child of the user would.
          env: { XDG_RUNTIME_DIR: runtimeDir },
        },
        async reap(exit) {
          let oomKilled = false;
          let state = null as Awaited<ReturnType<typeof showState>>;
          for (let poll = 0; poll < STOPPING_POLLS; poll++) {
            state = await showState(unit, workerSlice);
            if (!state) break;
            const group = state.slice.get("ControlGroup") ?? "";
            const kills = group ? counterOf(cgroupFile(group, "memory.events"), "oom_kill") : 0;
            // Only the worker's own death counts: a child killed earlier left the worker running (owner R2-1).
            if (exit.signal === "SIGKILL" && (state.unit.get("Result") === "oom-kill" || kills > 0))
              oomKilled = true;
            if (state.unit.get("ActiveState") !== "deactivating") break;
            await deps.clock.sleep(STOPPING_POLL_MS);
          }
          if (state?.unit.get("LoadState") !== "not-found") {
            await systemctlRun(["kill", "--signal=SIGKILL", unit]);
            await systemctlRun(["stop", unit]);
            await systemctlRun(["reset-failed", unit]);
          }
          if (state?.slice.get("LoadState") !== "not-found") await systemctlRun(["stop", workerSlice]);
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
