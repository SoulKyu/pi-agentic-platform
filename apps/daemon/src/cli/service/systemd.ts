import { execFile } from "node:child_process";
import { CliError } from "../open-home.ts";
import { unitStopTimeoutSec } from "./unit.ts";

type Bin = "systemctl" | "loginctl" | "journalctl";
const PASS_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"] as const;
const INVOCATION_ID = /^[0-9a-f]{32}$/;
const UNIT_NAME = /^[a-z][a-z0-9-]{0,40}\.service$/;
const SINCE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;
const UNIT = "pap.service";
const DEFAULT_TIMEOUT_MS = 15_000;
const ACTIVE_ENTER = /^\w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC$/;

function run(
  env: NodeJS.ProcessEnv,
  bin: Bin,
  args: readonly string[],
  timeout: number,
): Promise<{ code: number; stdout: string }> {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of PASS_ENV) if (env[name] !== undefined) childEnv[name] = env[name];
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { env: childEnv, timeout, maxBuffer: 1_048_576, windowsHide: true },
      (error, stdout) => {
        if (error === null) return resolve({ code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") return resolve({ code, stdout });
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return reject(new CliError(`${bin} output too large`, 1));
        const killed = (error as { killed?: unknown }).killed === true;
        reject(new CliError(`${bin} ${killed ? "timed out" : "could not be run"}`, 1)); // ENOENT, timeout: a fixed sentence
      },
    );
  });
}

const unitName = (unit: string): string => {
  if (!UNIT_NAME.test(unit)) throw new CliError("invalid unit name", 1);
  return unit;
};

export interface Systemd {
  userManagerUp(): Promise<boolean>;
  lingerEnabled(uid: number): Promise<boolean>;
  enableLinger(): Promise<boolean>;
  daemonReload(): Promise<void>;
  enable(unit: string): Promise<void>;
  /** `systemctl --user is-enabled --quiet`: true when the unit starts at boot or login. */
  isEnabled(unit: string): Promise<boolean>;
  restart(unit: string): Promise<void>;
  /** `systemctl --user reset-failed`, result ignored: the start limit counts manual starts too and only this clears it. */
  resetFailed(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  disable(unit: string): Promise<void>;
  isActive(unit: string): Promise<boolean>;
  /** `systemctl show -p LoadState`, e.g. "loaded" or "not-found"; null when it could not be read. */
  loadState(unit: string): Promise<string | null>;
  /** When the unit entered its current active state, as `YYYY-MM-DD HH:MM:SS UTC`; null when it never ran. */
  activeSince(unit: string): Promise<string | null>;
  invocationId(unit: string): Promise<string | null>;
  /** The unit's lines of the current start; `fallback` also tries `--since` when the invocation match is empty. */
  journal(invocationId: string, sinceUtc: string, fallback: boolean): Promise<string>;
  /** Everything the journal holds for pap.service since the restart, manager lines included; empty means unreadable. */
  journalAny(sinceUtc: string): Promise<string>;
}

/** The only place pap starts systemctl, loginctl or journalctl: argument lists, a filtered env, a timeout, fixed errors. */
export function createSystemd(env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Systemd {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const must = async (bin: Bin, args: readonly string[], what: string): Promise<string> => {
    const { code, stdout } = await run(env, bin, args, timeout);
    if (code !== 0) throw new CliError(`${bin} ${what} failed (exit ${code})`, 1);
    return stdout;
  };
  // restart and stop wait for the daemon's graceful shutdown: allow longer than the unit's TimeoutStopSec (M6R4).
  const slow = options.timeoutMs ?? (unitStopTimeoutSec() + 10) * 1000;
  const verb = async (name: string, unit: string, limit = timeout): Promise<void> => {
    const { code } = await run(env, "systemctl", ["--user", name, unitName(unit)], limit);
    if (code !== 0) throw new CliError(`systemctl ${name} failed (exit ${code})`, 1);
  };
  const journalctl = (selector: readonly string[]) =>
    must(
      "journalctl",
      [
        "--user",
        "-q",
        "-u",
        UNIT,
        `_SYSTEMD_USER_UNIT=${UNIT}`,
        ...selector,
        "-o",
        "cat",
        "--no-pager",
        "-n",
        "200",
      ],
      "read",
    );
  return {
    userManagerUp: async () =>
      (await run(env, "systemctl", ["--user", "show-environment"], timeout)).code === 0,
    lingerEnabled: async (uid) => {
      if (!Number.isInteger(uid) || uid < 0) throw new CliError("invalid uid", 1);
      const { stdout } = await run(
        env,
        "loginctl",
        ["show-user", String(uid), "--property=Linger", "--value"],
        timeout,
      );
      return stdout.trim() === "yes";
    },
    enableLinger: async () => {
      try {
        return (await run(env, "loginctl", ["enable-linger"], timeout)).code === 0;
      } catch (error) {
        if (error instanceof CliError) return false;
        throw error;
      }
    },
    daemonReload: async () => {
      await must("systemctl", ["--user", "daemon-reload"], "daemon-reload");
    },
    enable: (unit) => verb("enable", unit),
    isEnabled: async (unit) =>
      (await run(env, "systemctl", ["--user", "is-enabled", "--quiet", unitName(unit)], timeout)).code === 0,
    restart: (unit) => verb("restart", unit, slow),
    resetFailed: async (unit) => {
      const name = unitName(unit);
      try {
        await run(env, "systemctl", ["--user", "reset-failed", name], timeout);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
      }
    },
    stop: (unit) => verb("stop", unit, slow),
    disable: (unit) => verb("disable", unit),
    isActive: async (unit) =>
      (await run(env, "systemctl", ["--user", "is-active", "--quiet", unitName(unit)], timeout)).code === 0,
    loadState: async (unit) => {
      const { code, stdout } = await run(
        env,
        "systemctl",
        ["--user", "show", "-p", "LoadState", "--value", unitName(unit)],
        timeout,
      );
      return code === 0 && /^[a-z-]{1,32}$/.test(stdout.trim()) ? stdout.trim() : null;
    },
    activeSince: async (unit) => {
      const { code, stdout } = await run(
        env,
        "systemctl",
        ["--user", "show", "--timestamp=utc", "-p", "ActiveEnterTimestamp", "--value", unitName(unit)],
        timeout,
      );
      const match = code === 0 ? ACTIVE_ENTER.exec(stdout.trim()) : null;
      return match === null ? null : `${match[1]} UTC`;
    },
    invocationId: async (unit) => {
      const { stdout } = await run(
        env,
        "systemctl",
        ["--user", "show", "-p", "InvocationID", "--value", unitName(unit)],
        timeout,
      );
      const id = stdout.trim();
      return INVOCATION_ID.test(id) ? id : null;
    },
    journal: async (invocationId, sinceUtc, fallback) => {
      if (!INVOCATION_ID.test(invocationId)) throw new CliError("invalid invocation id", 1);
      if (!SINCE_UTC.test(sinceUtc)) throw new CliError("invalid journal start time", 1);
      const matched = await journalctl([`_SYSTEMD_INVOCATION_ID=${invocationId}`]);
      return matched.trim() === "" && fallback ? journalctl(["--since", sinceUtc]) : matched;
    },
    journalAny: async (sinceUtc) => {
      if (!SINCE_UTC.test(sinceUtc)) throw new CliError("invalid journal start time", 1);
      return must(
        "journalctl",
        ["--user", "-q", "-u", UNIT, "--since", sinceUtc, "-o", "cat", "--no-pager", "-n", "20"],
        "read",
      );
    },
  };
}
