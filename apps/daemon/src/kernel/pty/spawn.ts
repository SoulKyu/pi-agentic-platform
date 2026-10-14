import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename } from "node:path";
import type { Logger } from "../logger.ts";
import type { ScopeLaunch } from "../supervisor/scope.ts";
import { parseProcStat } from "./kill.ts";
import type { NodePty } from "./load.ts";

export const PTY_COLS = { min: 2, max: 500, fallback: 80 } as const;
export const PTY_ROWS = { min: 2, max: 200, fallback: 24 } as const;
const FALLBACK_SHELL = "/bin/sh";
/** Fixed text, no client input: sets the daemon's starting umask (R114), then becomes the shell (same pid). */
const UMASK_WRAPPER = 'umask "$1" && shift && exec "$@"';
const LOGIN_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);

export function clampSize(value: number, range: { min: number; max: number; fallback: number }): number {
  return Number.isInteger(value) ? Math.min(range.max, Math.max(range.min, value)) : range.fallback;
}

/** M8R52: `$SHELL` when it is a real executable file given as an absolute path, else /bin/sh. */
export function shellOf(env: NodeJS.ProcessEnv): string {
  const candidate = env.SHELL;
  if (candidate !== undefined && candidate.startsWith("/") && !candidate.includes("\0")) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.X_OK);
      if (statSync(real).isFile()) return candidate;
    } catch {
      // not usable: the fallback below
    }
  }
  return FALLBACK_SHELL;
}

export interface PtySpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: {
    readonly name: "xterm-256color";
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly encoding: null;
    readonly handleFlowControl: false;
  };
}

export function ptySpec(input: {
  readonly shell: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: ScopeLaunch | null;
  /** The umask the daemon was started with, before it set its own 077 (R114): the shell runs under it. */
  readonly umask: number;
}): PtySpec {
  const login = LOGIN_SHELLS.has(basename(input.shell)) ? ["-l"] : [];
  const { scope } = input;
  const mask = `0${(input.umask & 0o777).toString(8).padStart(3, "0")}`;
  const wrapped = [FALLBACK_SHELL, "-c", UMASK_WRAPPER, "pap-shell", mask, input.shell, ...login];
  return {
    file: scope ? scope.command : FALLBACK_SHELL,
    args: scope ? [...scope.args, ...wrapped] : wrapped.slice(1),
    options: {
      name: "xterm-256color",
      cols: clampSize(input.cols, PTY_COLS),
      rows: clampSize(input.rows, PTY_ROWS),
      cwd: input.cwd,
      env: { ...input.env, ...(scope?.env ?? {}) },
      encoding: null,
      handleFlowControl: false,
    },
  };
}

const OOM_SCORE_ADJ = "800";

export interface PtyProcess {
  readonly pid: number;
  /** The shell's /proc start, read right after the spawn (null without /proc). */
  readonly start: string | null;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  onData(listener: (chunk: Buffer) => void): void;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}

function readStart(pid: number): string | null {
  try {
    return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null;
  } catch {
    return null;
  }
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, n]) => [n, name]),
);

/** node-pty reports the signal's number; everything else in pap speaks names. */
const signalName = (signal: number): string => SIGNAL_NAMES.get(signal) ?? String(signal);

/** Spawns the PTY; its shell is first in line for the kernel's OOM killer (spec C §2.5, M8R54). */
export function spawnPty(pty: NodePty, spec: PtySpec, logger: Logger): PtyProcess {
  const child = pty.spawn(spec.file, [...spec.args], { ...spec.options, env: { ...spec.options.env } });
  try {
    writeFileSync(`/proc/${child.pid}/oom_score_adj`, OOM_SCORE_ADJ);
  } catch {
    logger.debug("pty_oom_score_adj_refused", { pid: child.pid });
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.onExit(({ exitCode, signal }) =>
      resolve(signal ? { code: null, signal: signalName(signal) } : { code: exitCode, signal: null }),
    );
  });
  return {
    pid: child.pid,
    start: readStart(child.pid),
    exited,
    onData: (listener) => {
      child.onData((chunk: string | Buffer) =>
        listener(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
      );
    },
    write: (data) => child.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
    resize: (cols, rows) => child.resize(clampSize(cols, PTY_COLS), clampSize(rows, PTY_ROWS)),
    pause: () => child.pause(),
    resume: () => child.resume(),
  };
}
