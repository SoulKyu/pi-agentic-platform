import { type ChildProcessByStdio, spawn } from "node:child_process";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { type Clock, createSystemClock, type TimerHandle } from "../clock.ts";
import { type EnvSource, NETWORK_ENV, TOOLING_ENV, unattendedEnv } from "../child-env.ts";
import type { Logger } from "../logger.ts";
import { maskedStdio } from "../pty/fd-mask.ts";
import { releaseGroup, signalGroup, trackGroup } from "../supervisor/process-group.ts";

/**
 * M9R47 (owner c7): the CLI's own login answers (its config under `XDG_CONFIG_HOME` / `GH_CONFIG_DIR`): no token
 * variable, no SSH agent. Its own git children stop discovering repositories at the empty forge folder (M9-RT-21).
 */
export function forgeEnv(base: EnvSource, forgeDir: string): Record<string, string> {
  return unattendedEnv(base, {
    keep: [...NETWORK_ENV, ...TOOLING_ENV, "GH_CONFIG_DIR"],
    set: {
      LC_ALL: "C",
      NO_COLOR: "1",
      CLICOLOR: "0",
      PAGER: "cat",
      GH_PAGER: "cat",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: dirname(forgeDir),
    },
  });
}

export type ForgeOutcome =
  "forge_missing" | "not_signed_in" | "not_found" | "timeout" | "too_large" | "failed";
export type ForgeResult<T> = { ok: true; value: T } | { ok: false; outcome: ForgeOutcome };
export type ForgeRun = { ok: true; stdout: string } | { ok: false; outcome: ForgeOutcome };

export const FORGE_TIMEOUT_MS = 30_000;
export const FORGE_CREATE_TIMEOUT_MS = 60_000;
export const FORGE_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Stderr is read for classification only (M9R48). */
const STDERR_KEEP_BYTES = 64 * 1024;
const STDERR_LOG_CHARS = 300;
const PIPE_GRACE_MS = 1000;

const SIGNED_OUT = /gh auth login|not logged|authentication|HTTP 401/i;
const MISSING = /Could not resolve to|HTTP 404|not found/i;

export function classifyStderr(stderr: string): "not_signed_in" | "not_found" | "failed" {
  if (SIGNED_OUT.test(stderr)) return "not_signed_in";
  if (MISSING.test(stderr)) return "not_found";
  return "failed";
}

export interface RunForgeOptions {
  /** The empty forge folder: never a repository (M9R46). */
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, then stdin ends. */
  input?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  /** How long a stray process may keep the pipes open after the group is killed (default 1 s). */
  pipeGraceMs?: number;
  logger: Logger;
  clock?: Clock;
  /** For the log line only. */
  forge: string;
  op: string;
}

/**
 * Starts the forge CLI without a shell, in a process group of its own that is killed at the deadline, when stdout
 * passes its cap and at the daemon's exit. Never rejects: every outcome is a value (M9R48).
 */
export function runForge(bin: string, args: readonly string[], options: RunForgeOptions): Promise<ForgeRun> {
  const clock = options.clock ?? createSystemClock();
  const cap = options.maxStdoutBytes ?? FORGE_MAX_STDOUT_BYTES;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let verdict: "timeout" | "too_large" | null = null;
    let timer: TimerHandle | null = null;
    const graces: TimerHandle[] = [];
    let settled = false;

    const fail = (outcome: ForgeOutcome, code: unknown, stderr: string): void => {
      options.logger.warn("forge_failed", {
        forge: options.forge,
        op: options.op,
        outcome,
        code,
        stderr: stderr.slice(0, STDERR_LOG_CHARS),
      });
      resolve({ ok: false, outcome });
    };
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(bin, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: maskedStdio(["pipe", "pipe", "pipe"]),
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === "ENOENT" ? "forge_missing" : "failed", code, "");
    }
    const pid = child.pid;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      for (const grace of graces) clock.clearTimeout(grace);
      if (pid !== undefined) releaseGroup(pid);
      settle();
    };
    if (pid !== undefined) trackGroup(pid);
    const killGroup = (): void => void signalGroup(pid, "SIGKILL");
    const graceMs = options.pipeGraceMs ?? PIPE_GRACE_MS;
    /** A process that left the group may hold the pipes: after the grace the call ends with the verdict anyway. */
    const killAndEnd = (): void => {
      killGroup();
      graces.push(
        clock.setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(() => fail(verdict ?? "failed", null, Buffer.concat(err).toString("utf8")));
        }, graceMs),
      );
    };

    timer = clock.setTimeout(() => {
      verdict ??= "timeout";
      killAndEnd();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > cap) {
        verdict ??= "too_large";
        killAndEnd();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= STDERR_KEEP_BYTES) err.push(chunk);
    });
    child.once("error", (error) =>
      finish(() => {
        const code = (error as NodeJS.ErrnoException).code;
        fail(code === "ENOENT" ? "forge_missing" : "failed", code, "");
      }),
    );
    // The CLI may exit without reading its input: its exit code says what happened.
    child.stdin.on("error", () => undefined);
    child.once("exit", () => {
      killGroup();
      graces.push(
        clock.setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, graceMs),
      );
    });
    child.once("close", (code) =>
      finish(() => {
        const stderr = Buffer.concat(err).toString("utf8");
        if (verdict !== null) return fail(verdict, code, stderr);
        if (code === 0) return resolve({ ok: true, stdout: Buffer.concat(out).toString("utf8") });
        fail(classifyStderr(stderr), code, stderr);
      }),
    );
    child.stdin.end(options.input);
  });
}
