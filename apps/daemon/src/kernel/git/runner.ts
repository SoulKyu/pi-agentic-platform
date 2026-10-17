import { type ChildProcessByStdio, spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PapError } from "@pap/contracts";
import type { Logger } from "../logger.ts";
import { maskedStdio } from "../pty/fd-mask.ts";
import { cutUnits } from "../text.ts";
import { type GitProfile, prepare } from "./allowlist.ts";
import { gitArgs, gitEnv, isAgentGitCall, isLaneGitDir, WORK_TREE_PINNED } from "./exec.ts";
import { stageInputAllowed } from "./stage.ts";

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
  /**
   * The lane's git dir, `<common>/worktrees/<name>`, from pap's record and never from the lane's `.git` file (MC1 I4).
   * Required by `add`, `commit`, `restore`, `clean` and `reset`; then `--git-dir` is pinned next to `--work-tree`.
   */
  gitDir?: string;
  /**
   * `GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>` (MC13), `GIT_INDEX_FILE` as `<indexDir>/idx-<32 hex>`, pap's own author and
   * committer identity and `GIT_LFS_SKIP_SMUDGE=1` (M9R11); any other name or value is refused before git starts.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * `remote` is for `push` alone (M9R10): the owner's credential helpers and SSH agent, `https` and `ssh` only. Every
   * other call is `local`, the default, and `push` is refused under it.
   */
  profile?: GitProfile;
  /** Return git's stderr (UTF-8, the first 64 KiB) for the caller to classify; never logged beyond 300 characters (M9R12). */
  keepStderr?: boolean;
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
  ): Promise<{ stdout: Buffer; code: number; stderr?: string }>;
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
  /** Where temporary indexes live (`$PAP_HOME/tmp/git-index`, M9R11). Absent: no `GIT_INDEX_FILE` is accepted. */
  indexDir?: string;
  /** The transports a push may use (default `https:ssh`); tests alone replace it (`Config.testGitProtocols`). */
  remoteProtocols?: string;
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

const CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_\d{1,3}|VALUE_\d{1,3})$/;
/** Checkpoint commits are pap's own: these values and no others. */
export const PAP_IDENTITY = { name: "pap", email: "pap@users.noreply.invalid" } as const;
const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: PAP_IDENTITY.name,
  GIT_AUTHOR_EMAIL: PAP_IDENTITY.email,
  GIT_COMMITTER_NAME: PAP_IDENTITY.name,
  GIT_COMMITTER_EMAIL: PAP_IDENTITY.email,
};
const INDEX_NAME = /^idx-[0-9a-f]{32}$/;

/** The extra environment a caller may add (M9R11, MC13): config entries, a temporary index, pap's identity, the LFS switch. */
function extraEnv(env: GitRunOptions["env"], indexDir: string | null): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    const allowed =
      CONFIG_ENV.test(name) ||
      (Object.hasOwn(IDENTITY, name) && IDENTITY[name] === value) ||
      (name === "GIT_INDEX_FILE" &&
        indexDir !== null &&
        dirname(value) === indexDir &&
        INDEX_NAME.test(basename(value))) ||
      (name === "GIT_LFS_SKIP_SMUDGE" && value === "1");
    if (!allowed) return null;
    out[name] = value;
  }
  return out;
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
      const added = extraEnv(options.env, deps.indexDir ?? null);
      const profile = options.profile ?? "local";
      const prepared = prepare(args, profile, added ?? {});
      if (!prepared || !added) throw fail("failed", args, null);
      const sub = args[0] ?? "";
      if (
        options.gitDir !== undefined &&
        !isLaneGitDir(options.gitDir) &&
        !isAgentGitCall(sub, root, options.gitDir)
      )
        throw fail("failed", args, null);
      if (WORK_TREE_PINNED.has(sub) && options.gitDir === undefined) throw fail("failed", args, null);
      // MC1 I3: the staged list is capped, and `add` (and a listed `restore`) has no other source of paths.
      const listed =
        sub === "add" || sub === "rm" || (sub === "restore" && args.includes("--pathspec-from-file=-"));
      if (listed && !stageInputAllowed(options.input)) throw fail("failed", args, null);
      const queued = acquire();
      if (queued) await queued;
      try {
        const okCodes = options.okCodes ?? [0];
        let result: ExecResult;
        try {
          result = await exec(
            "git",
            gitArgs(root, prepared, options.gitDir, profile),
            {
              env: { ...gitEnv(deps.env, root, profile, deps.remoteProtocols), ...added },
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
        return options.keepStderr === true
          ? { stdout: result.stdout, code: result.code, stderr: result.stderr.toString("utf8") }
          : { stdout: result.stdout, code: result.code };
      } finally {
        release();
      }
    },
  };
}
