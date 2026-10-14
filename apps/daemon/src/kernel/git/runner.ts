import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { PapError } from "@pap/contracts";
import type { Logger } from "../logger.ts";
import { maskedStdio } from "../pty/fd-mask.ts";
import { cutUnits } from "../text.ts";
import { FILTER_SCAN_ARGS, gitArgs, gitEnv } from "./exec.ts";

export type GitErrorKind = "git_missing" | "timeout" | "too_large" | "failed" | "git_too_old";

const MESSAGES: Record<GitErrorKind, string> = {
  git_missing: "git is not installed",
  timeout: "git timed out",
  too_large: "git produced too much output",
  failed: "git failed",
  git_too_old: "git is too old to run safely in this repository",
};

/** A typed failure with a fixed message: git's stderr and the paths go to the log only (C 4.1). */
export class GitError extends Error {
  readonly kind: GitErrorKind;

  constructor(kind: GitErrorKind) {
    super(MESSAGES[kind]);
    this.name = "GitError";
    this.kind = kind;
  }
}

export interface GitRunOptions {
  /** Deadline in ms, SIGKILL at the end (default 10 s). */
  timeoutMs?: number;
  /** Output cap in bytes (default 8 MiB). */
  maxBytes?: number;
  /** Exit codes that resolve (default `[0]`). */
  okCodes?: readonly number[];
  /** Bytes written to git's stdin (`check-ignore --stdin`). Without it stdin is empty, so a read ends at once. */
  input?: Buffer;
  /** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` only (MC13); any other name is refused. */
  env?: Readonly<Record<string, string>>;
}

export interface GitRunner {
  /**
   * `root` must be a real path (no symlink): the discovery ceiling is computed from its text. `args[0]` is the
   * subcommand; the runner adds `--no-ext-diff --no-textconv` after `diff`, `log` and `show` and refuses an
   * argument that would switch them back on.
   */
  run(
    root: string,
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<{ stdout: Buffer; code: number }>;
}

interface ExecOptions {
  env: NodeJS.ProcessEnv;
  encoding: "buffer";
  maxBuffer: number;
  timeout: number;
  killSignal: "SIGKILL";
  shell: false;
  windowsHide: true;
  /** Git leads its own process group, so a timeout can kill the programs it started too. */
  detached: true;
}

type ExecResult = { stdout: Buffer; stderr: Buffer; code: number };
type Exec = (file: string, args: string[], options: ExecOptions, input?: Buffer) => Promise<ExecResult>;

export interface GitRunnerDeps {
  /** The daemon's environment; only an allowlist reaches git (M8R21). */
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Replaced in tests. */
  exec?: Exec;
  maxConcurrent?: number;
  maxWaiting?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_LOG_CHARS = 300;

/** How long a descendant that left git's process group may keep git's output pipes open once git has exited. */
const PIPE_GRACE_MS = 1000;
/** Only the start of stderr is ever read (300 characters go to the log). */
const STDERR_KEEP_BYTES = 64 * 1024;

/**
 * Resolves on any exit code (the caller judges it); rejects on a spawn failure, a kill or a full buffer. Git leads its
 * own process group (`execFile` cannot do that, hence `spawn`) and the whole group is killed when git exits or runs out
 * of time: a filter or helper it started must not outlive the call or the 4-process cap. Pipes still held by a program
 * that left the group are closed after a short grace.
 */
const execGit: Exec = (file, args, options, input) =>
  new Promise((resolve, reject) => {
    // MC38: the daemon's PTY masters reach a filter driver git starts unless the child's table maps them to /dev/null.
    const child = spawn(file, args, {
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: maskedStdio(["pipe", "pipe", "pipe"]),
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let aborted: Error | null = null;
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined || pid <= 1) return;
      try {
        process.kill(-pid, options.killSignal);
      } catch {
        // ESRCH: the group is already empty, which is the normal case.
      }
    };
    const abort = (code?: string): void => {
      aborted ??= Object.assign(new Error("git aborted"), { code, killed: true, signal: options.killSignal });
      killGroup();
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      settle();
    };
    const timer = (ms: number, run: () => void): void => {
      const handle = setTimeout(run, ms);
      handle.unref();
      timers.add(handle);
    };

    timer(options.timeout, () => abort());
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > options.maxBuffer) abort("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= STDERR_KEEP_BYTES) err.push(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", () => {
      killGroup();
      timer(PIPE_GRACE_MS, () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
    });
    child.once("close", (code, signal) =>
      finish(() => {
        if (aborted) return reject(Object.assign(aborted, { stderr: Buffer.concat(err) }));
        if (code === null)
          return reject(Object.assign(new Error("git was killed"), { killed: false, signal }));
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code });
      }),
    );
    // Git may exit before it reads its input; the exit code tells what happened.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

function classify(error: unknown): GitErrorKind {
  const { code, killed, signal } = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "too_large";
  if (code === "ENOENT") return "git_missing";
  // Node sets `killed` only for its own timeout kill; a SIGKILL from outside (the OOM killer) is a failure.
  if (killed === true && signal === "SIGKILL") return "timeout";
  return "failed";
}

const NO_EXTERNAL_PROGRAMS = ["diff", "log", "show"];

/** What the runner itself adds to diff, log and show; a caller may spell it too (M8R46 does). */
const OWN_OPTIONS = ["--no-ext-diff", "--no-textconv"];

/**
 * MC18: the exact options each planned caller passes, nothing else. A blocklist was bypassed three times (git has
 * abbreviations, clusters, `-m` with a config value, `--decorate-refs --`...), so an option is accepted only when it is
 * spelled exactly as here: no abbreviation, no cluster, no `--opt value` form. Positional arguments (revs, pathspecs)
 * are accepted when they do not start with `-`, and after `--` too. A caller that needs another option extends this
 * table together with its own review of what that option can start.
 */
const SUBCOMMANDS: Record<
  string,
  {
    options: readonly string[];
    positional: boolean;
    /** Every positional starts with `./` (MC15). */ dotSlash?: true;
  }
> = {
  // Task 4 brief tests: repository root and branch name.
  "rev-parse": { options: ["--show-toplevel", "--abbrev-ref"], positional: true },
  // M8R46: status --porcelain=v2 -z --branch --ignore-submodules=dirty
  status: { options: ["--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"], positional: true },
  // M8R46: diff --numstat -z --ignore-submodules=dirty (a nested repository's own filters, MC13) --no-ext-diff --no-textconv HEAD --
  diff: { options: ["--numstat", "-z", "--ignore-submodules=dirty", ...OWN_OPTIONS], positional: true },
  // No planned caller yet (M9): only the runner's own options.
  log: { options: OWN_OPTIONS, positional: true },
  show: { options: OWN_OPTIONS, positional: true },
  // M8R47: cat-file blob <spec>
  "cat-file": { options: [], positional: true },
  // M8R24: ls-files -z --cached -- ; M8R27: ls-files -z --cached --others --exclude-standard
  "ls-files": { options: ["-z", "--cached", "--others", "--exclude-standard"], positional: true },
  // M8R24: check-ignore -z --stdin --no-index. It runs without --literal-pathspecs (exit 128 under it, MC15), so a path
  // given as an argument must start with `./`: ':(glob)x' would be pathspec magic. Names on stdin are the caller's
  // to prefix the same way (modules/files/visibility.ts).
  "check-ignore": { options: ["-z", "--stdin", "--no-index"], positional: true, dotSlash: true },
  // No planned caller (tests read stdin); a file argument would run a clean filter, so none is accepted.
  "hash-object": { options: ["--stdin"], positional: false },
};

/** The runner's own arguments: an allowlisted subcommand with only its listed options, `--no-ext-diff --no-textconv` after diff/log/show (MC12). */
function prepare(args: readonly string[]): string[] | null {
  // MC13: the one `config` call there is, exactly as the filter guard spells it (a bare `config` could write).
  if (args.length === FILTER_SCAN_ARGS.length && FILTER_SCAN_ARGS.every((arg, at) => args[at] === arg))
    return [...args];
  const [subcommand, ...rest] = args;
  const rule =
    subcommand === undefined
      ? undefined
      : Object.hasOwn(SUBCOMMANDS, subcommand)
        ? SUBCOMMANDS[subcommand]
        : undefined;
  if (subcommand === undefined || !rule) return null;
  let afterDashes = false;
  for (const arg of rest) {
    if (!afterDashes && arg === "--") {
      afterDashes = true;
      continue;
    }
    if (arg.startsWith("-")) {
      // After `--` nothing may look like an option; before it only the exact listed spellings.
      if (afterDashes || !rule.options.includes(arg)) return null;
    } else if (!rule.positional || (rule.dotSlash && !arg.startsWith("./"))) return null;
  }
  return NO_EXTERNAL_PROGRAMS.includes(subcommand)
    ? [subcommand, ...OWN_OPTIONS, ...rest]
    : [subcommand, ...rest];
}

const CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_\d{1,3}|VALUE_\d{1,3})$/;

/** The extra environment a caller may add: config entries and nothing else (MC13). */
function extraEnv(env: GitRunOptions["env"]): Record<string, string> | null {
  const entries = Object.entries(env ?? {});
  return entries.every(([name]) => CONFIG_ENV.test(name)) ? Object.fromEntries(entries) : null;
}

/** M8R22: at most `maxConcurrent` git processes at once, `maxWaiting` queued; the next call is refused, nothing is evicted. */
export function createGitRunner(deps: GitRunnerDeps): GitRunner {
  const exec = deps.exec ?? execGit;
  const maxConcurrent = deps.maxConcurrent ?? 4;
  const maxWaiting = deps.maxWaiting ?? 64;
  let running = 0;
  const waiting: Array<() => void> = [];

  // Not async: a free slot is taken in the same tick as the call, so check and take cannot interleave.
  const acquire = (): Promise<void> | null => {
    if (running < maxConcurrent) {
      running += 1;
      return null;
    }
    if (waiting.length >= maxWaiting) return Promise.reject(new PapError("capacity"));
    // The slot is handed over by `release` without being freed, so a new call cannot jump the queue.
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const fail = (kind: GitErrorKind, args: readonly string[], stderr: Buffer | null): GitError => {
    deps.logger.warn("git_failed", {
      subcommand: args[0] ?? "",
      kind,
      stderr: cutUnits(stderr?.toString("utf8") ?? "", STDERR_LOG_CHARS),
    });
    return new GitError(kind);
  };

  return {
    async run(root, args, options = {}) {
      const prepared = prepare(args);
      const added = extraEnv(options.env);
      if (!prepared || !added) throw fail("failed", args, null);
      const queued = acquire();
      if (queued) await queued;
      try {
        const okCodes = options.okCodes ?? [0];
        let result: ExecResult;
        try {
          result = await exec(
            "git",
            gitArgs(root, prepared),
            {
              env: { ...gitEnv(deps.env, root), ...added },
              encoding: "buffer",
              maxBuffer: options.maxBytes ?? DEFAULT_MAX_BYTES,
              timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              killSignal: "SIGKILL",
              shell: false,
              windowsHide: true,
              detached: true,
            },
            options.input,
          );
        } catch (error) {
          const stderr = (error as { stderr?: unknown }).stderr;
          throw fail(classify(error), args, Buffer.isBuffer(stderr) ? stderr : null);
        }
        if (!okCodes.includes(result.code)) throw fail("failed", args, result.stderr);
        return { stdout: result.stdout, code: result.code };
      } finally {
        release();
      }
    },
  };
}
