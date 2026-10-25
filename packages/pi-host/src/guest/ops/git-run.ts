import { spawn } from "node:child_process";
import { disablingEnv, driversToDisable, FILTER_SCAN_ARGS, gitArgs, gitEnv } from "@pap/contracts/pi-host";
import { OpError } from "./paths.ts";

export interface GitOptions {
  /** Written to git's standard input. */
  readonly input?: Buffer;
  /** Exit codes that are an answer; any other is `failed`. */
  readonly okCodes?: readonly number[];
  readonly timeoutMs?: number;
  /** More output than this is `payload_too_large`. */
  readonly maxBytes?: number;
  /** More `-c key=value` pairs, placed after the neutralising ones so they win (a signed commit's identity, a credential helper). */
  readonly config?: readonly string[];
  /** More environment variables, laid over the git environment (a signed commit's run folder). */
  readonly env?: Readonly<Record<string, string>>;
  /** A network call (clone, push): the daemon's `remote` profile, with `env` laid over the git environment. */
  readonly remote?: { readonly protocols: string; readonly env: Readonly<Record<string, string>> };
}

export interface GitOutput {
  readonly code: number;
  readonly stdout: Buffer;
}

export const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** `status` and `diff` compare, hash or check out files, so a clean or smudge filter of the repository would run. */
const FILTERING = new Set(["status", "diff", "add", "commit"]);

/** The environment of every git run here: the daemon's allowlist, and no user or system configuration (the VM's home is the agent's). */
export function guestGitEnv(
  base: NodeJS.ProcessEnv,
  root: string,
  remote?: GitOptions["remote"],
): NodeJS.ProcessEnv {
  return {
    ...(remote ? gitEnv(base, root, "remote", remote.protocols) : gitEnv(base, root)),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    ...remote?.env,
  };
}

/** The neutralised command line of contracts, and the project named as safe (exactly, never `*`): the tree's owner may not be the guest's uid. */
export const guestGitArgs = (
  root: string,
  args: readonly string[],
  options: Pick<GitOptions, "config" | "remote"> = {},
): string[] => {
  const full = gitArgs(root, args, undefined, options.remote ? "remote" : "local");
  const extra = (options.config ?? []).flatMap((pair) => ["-c", pair]);
  full.splice(full.length - args.length, 0, ...extra);
  return ["-c", `safe.directory=${root}`, ...full];
};

function runRaw(
  root: string,
  args: readonly string[],
  extraEnv: Record<string, string>,
  options: GitOptions,
  base: NodeJS.ProcessEnv,
): Promise<GitOutput> {
  const okCodes = options.okCodes ?? [0];
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("git", guestGitArgs(root, args, options), {
      cwd: root,
      env: { ...guestGitEnv(base, root, options.remote), ...extraEnv, ...options.env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: OpError | undefined;
    const stop = (error: OpError): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new OpError("timeout")), options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new OpError("payload_too_large"));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new OpError("failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === null || !okCodes.includes(code)) return reject(new OpError("failed"));
      resolve({ code, stdout: Buffer.concat(chunks) });
    });
  });
}

/**
 * Runs git in `root` with the neutralised command line and environment of contracts (no fsmonitor, hooks, external diff or
 * textconv; no user, global or system configuration). `status` and `diff` first learn the repository's filter drivers and
 * run with them emptied, as the host's runner does.
 */
export async function runGit(
  root: string,
  args: readonly string[],
  options: GitOptions = {},
  base: NodeJS.ProcessEnv = process.env,
): Promise<GitOutput> {
  let extra: Record<string, string> = {};
  if (FILTERING.has(args[0] ?? "")) {
    const scan = await runRaw(
      root,
      FILTER_SCAN_ARGS,
      {},
      { okCodes: [0, 1], ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
      base,
    );
    const drivers = driversToDisable(scan.stdout);
    if (drivers === null) throw new OpError("failed");
    extra = disablingEnv(drivers);
  }
  return runRaw(root, args, extra, options, base);
}
