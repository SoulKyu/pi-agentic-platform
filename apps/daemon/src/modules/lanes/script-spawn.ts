import { spawn } from "node:child_process";
import type { ScriptKind } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { type EnvSource, NETWORK_ENV, TOOLING_ENV, unattendedEnv } from "../../kernel/child-env.ts";
import { maskedStdio } from "../../kernel/pty/fd-mask.ts";
import type { ScopeLaunch } from "../../kernel/supervisor/scope.ts";

export const SCRIPT_DEADLINE_MS: Readonly<Record<ScriptKind, number>> = {
  setup: 30 * 60_000,
  archive: 5 * 60_000,
  test: 15 * 60_000,
};
export const SCRIPT_LOG_BYTES = 5 * 1024 * 1024;
export const SCRIPT_TERM_GRACE_MS = 5000;
export const SCRIPTS_PER_OWNER = 2;
/** After the script's own process ended: how long a holder of its pipes (outside the group) may keep the output open. */
export const SCRIPT_DRAIN_MS = 2000;

/** Fixed text, no client input: the daemon's starting umask (R114), then bash runs the approved script (same pid). */
const UMASK_WRAPPER = 'umask "$1" && shift && exec "$@"';

export interface ScriptSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** M9R28 (owner c7): the shared unattended allowlist, the network and tooling names, and the lane's three facts. */
export function scriptEnv(
  base: EnvSource,
  lane: { readonly id: string; readonly root: string; readonly worktree: string },
): Record<string, string> {
  return unattendedEnv(base, {
    keep: [...NETWORK_ENV, ...TOOLING_ENV],
    set: { PAP_LANE_ID: lane.id, PAP_LANE_ROOT: lane.root, PAP_LANE_WORKTREE: lane.worktree },
  });
}

export function scriptSpec(input: {
  readonly kind: ScriptKind;
  /** The approved text, byte for byte (Task 4). */
  readonly script: string;
  readonly umask: number;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: ScopeLaunch | null;
}): ScriptSpec {
  const mask = `0${(input.umask & 0o777).toString(8).padStart(3, "0")}`;
  const name = `pap-lane-${input.kind}`;
  const wrapped = ["/bin/sh", "-c", UMASK_WRAPPER, name, mask, "bash", "-e", "-c", input.script, name];
  const { scope } = input;
  return {
    file: scope ? scope.command : "/bin/sh",
    args: scope ? [...scope.args, ...wrapped] : wrapped.slice(1),
    env: { ...input.env, ...(scope?.env ?? {}) },
  };
}

export interface ScriptExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** One running script: stdout and stderr arrive interleaved in one stream; `exited` settles once the output is drained. */
export interface ScriptChild {
  readonly pid: number;
  onOutput(listener: (chunk: Buffer) => void): void;
  readonly exited: Promise<ScriptExit>;
}
export type SpawnScript = (spec: ScriptSpec, cwd: string) => ScriptChild;

/**
 * The real spawn: its own process group (`detached`), stdin closed at once, the terminals' PTY masters masked, and the
 * spec's environment as the whole environment. Throws when the process did not start.
 */
export function spawnScript(clock: Clock): SpawnScript {
  return (spec, cwd) => {
    const child = spawn(spec.file, [...spec.args], {
      cwd,
      env: { ...spec.env },
      detached: true,
      stdio: maskedStdio(["pipe", "pipe", "pipe"]),
    });
    // A failed start is told through `pid === undefined` below; the event still has to be handled.
    child.on("error", () => undefined);
    const { pid, stdin, stdout, stderr } = child;
    if (pid === undefined || !stdin || !stdout || !stderr) {
      child.kill();
      throw new Error("script did not start");
    }
    // The script reads nothing: a write to a closed pipe must not surface as an error.
    stdin.on("error", () => undefined);
    stdin.end();
    const listeners: Array<(chunk: Buffer) => void> = [];
    const feed = (chunk: Buffer): void => {
      for (const listener of listeners) listener(chunk);
    };
    stdout.on("data", feed);
    stderr.on("data", feed);
    const exited = new Promise<ScriptExit>((resolve) => {
      let exit: ScriptExit | null = null;
      let timer: ReturnType<Clock["setTimeout"]> | undefined;
      const finish = (): void => {
        if (timer) clock.clearTimeout(timer);
        stdout.destroy();
        stderr.destroy();
        resolve(exit ?? { code: null, signal: null });
      };
      child.once("exit", (code, signal) => {
        exit = signal ? { code: null, signal } : { code, signal: null };
        timer = clock.setTimeout(finish, SCRIPT_DRAIN_MS);
      });
      child.once("close", () => {
        if (exit) finish();
      });
      child.once("error", () => {
        exit ??= { code: null, signal: null };
        finish();
      });
    });
    return { pid, onOutput: (listener) => void listeners.push(listener), exited };
  };
}
