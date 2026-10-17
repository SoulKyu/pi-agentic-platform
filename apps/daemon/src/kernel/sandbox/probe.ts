import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";

/** Where a system bwrap lives. Never PATH: an agent (or a project) could plant a `bwrap` in a folder PATH names. */
export const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"] as const;
export const PROBE_TIMEOUT_MS = 5_000;
/** A failed probe is tried again before a launch only when it is older than this (M11R19). */
export const PROBE_RETRY_MS = 60_000;
const PROBE_OUTPUT_BYTES = 256;

export type SandboxProbe =
  | { readonly usable: true; readonly path: string }
  | { readonly usable: false; readonly reason: "missing" | "unsafe_path" | "refused" | "timeout" };

/** The kernel `Clock`'s timer half (`kernel/clock.ts`). */
export interface ProbeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProbeDeps {
  readonly timers: ProbeTimers;
  /** Test seam; `child_process.spawn` by default. */
  readonly spawn?: typeof nodeSpawn;
  /** Where the canary folder is made; `os.tmpdir()` by default. */
  readonly tmp?: string;
  /** Told when the canary folder cannot be removed (the probe still ends). */
  readonly logger?: Logger;
}

/** The two file system reads `trustedBinary` makes (a test seam; the real ones by default). */
export interface TrustOps {
  realpath(path: string): string;
  stat(path: string): { uid: number; mode: number; isFile(): boolean };
}
const realOps: TrustOps = { realpath: (path) => realpathSync(path), stat: (path) => statSync(path) };

const rootOnly = (stat: { uid: number; mode: number }): boolean =>
  stat.uid === 0 && (stat.mode & 0o022) === 0;

/**
 * A binary the sandbox may run: absolute, its real path a regular executable file owned by root and writable by root
 * alone, and every folder from that file up to `/` owned by root and writable by root alone (so nobody but root can
 * swap it, or a folder on its way). `PAP_BWRAP` must pass the same test. Returns the real path, or null.
 */
export function trustedBinary(path: string, ops: TrustOps = realOps): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  try {
    const real = ops.realpath(path);
    const file = ops.stat(real);
    if (!file.isFile() || !rootOnly(file) || (file.mode & 0o111) === 0) return null;
    for (let dir = dirname(real); ; dir = dirname(dir)) {
      if (!rootOnly(ops.stat(dir))) return null;
      if (dir === "/") return real;
    }
  } catch {
    return null;
  }
}

/** The strictest set the sandbox uses (network off), plus a canary folder hidden like the owner's home is. */
export const probeArgs = (canaryDir: string): string[] => [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--tmpfs",
  "/run",
  "--tmpfs",
  "/tmp",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--tmpfs",
  canaryDir,
  "--die-with-parent",
  "--new-session",
  "--",
  "/bin/sh",
  "-c",
  'test ! -e "$1" && echo "$2"',
  "sh",
];

/**
 * The real path of the canary's parent: bwrap 0.11.1 refuses a `--tmpfs` target whose path crosses an absolute link of the
 * read-only root (a linked `~/.pap`), which would make the probe `refused` and every agent launch `sandbox_unavailable`.
 */
const realFolderOf = (folder: string): string => {
  try {
    return realpathSync(folder);
  } catch {
    return folder; // the mkdtemp that follows fails the probe closed
  }
};

/** At boot: the canary folders a probe killed in the middle left in `folder` (`pap-probe-*`, ours, never anything else). */
export function removeStaleProbes(folder: string, logger?: Logger): void {
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      // A folder or a link only; a link is unlinked, never followed (`rmSync` of one removes the link itself).
      if (!entry.name.startsWith("pap-probe-") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      rmSync(join(folder, entry.name), { recursive: true, force: true });
    }
  } catch (error) {
    logger?.warn("sandbox_probe_cleanup_failed", { err: error });
  }
}

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Runs the real binary with the real flags, an empty environment and stdout captured, killed (group) at the deadline.
 * Usable only when the command inside answers the nonce and could not see the canary file the probe made outside: a
 * root binary that exits 0 without sandboxing anything (`/usr/bin/true`) is refused. Ubuntu's AppArmor allows
 * unprivileged user namespaces to the system bwrap only, so a copy elsewhere fails here too (S8).
 */
export function probeSandbox(override: string | undefined, deps: ProbeDeps): Promise<SandboxProbe> {
  const candidates = override !== undefined ? [override] : [...BWRAP_CANDIDATES];
  let path: string | null = null;
  for (const candidate of candidates) {
    path = trustedBinary(candidate);
    if (path !== null) break;
  }
  if (path === null) {
    const present = candidates.some(isFile);
    return Promise.resolve({ usable: false, reason: present ? "unsafe_path" : "missing" });
  }
  const binary = path;
  const dir = mkdtempSync(join(realFolderOf(deps.tmp ?? tmpdir()), "pap-probe-"));
  const canary = join(dir, "canary");
  const nonce = randomBytes(16).toString("hex");
  return new Promise<SandboxProbe>((resolve) => {
    let settled = false;
    let output = "";
    const timer: { handle?: unknown } = {};
    const done = (probe: SandboxProbe) => {
      if (settled) return;
      settled = true;
      if (timer.handle !== undefined) deps.timers.clearTimeout(timer.handle);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        deps.logger?.warn("sandbox_probe_cleanup_failed");
      }
      resolve(probe);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      writeFileSync(canary, "", { mode: 0o600 });
      child = (deps.spawn ?? nodeSpawn)(binary, [...probeArgs(dir), canary, nonce], {
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      done({ usable: false, reason: "refused" });
      return;
    }
    timer.handle = deps.timers.setTimeout(() => {
      try {
        if (child.pid !== undefined && child.pid > 1) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      done({ usable: false, reason: "timeout" });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < PROBE_OUTPUT_BYTES) output += chunk.toString("utf8").slice(0, PROBE_OUTPUT_BYTES);
    });
    child.once("error", () => done({ usable: false, reason: "refused" }));
    child.once("close", (code) =>
      done(
        code === 0 && output.trim() === nonce
          ? { usable: true, path: binary }
          : { usable: false, reason: "refused" },
      ),
    );
  });
}

export type CheckedProbe = SandboxProbe & { readonly checkedAt: number };

export interface SandboxProbeService {
  /** The last result; not usable until the first probe has ended. */
  current(): CheckedProbe;
  /** Probes now (one at a time: a call during a probe shares it). Never rejects. */
  recheck(): Promise<SandboxProbe>;
  /** Before a launch: the last result when usable or younger than 60 s, else a fresh probe (M11R19). */
  ensure(): Promise<SandboxProbe>;
}

export interface SandboxProbeOptions {
  readonly override: string | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Test seam; `probeSandbox` on the kernel clock by default. */
  readonly probe?: (override: string | undefined) => Promise<SandboxProbe>;
  /**
   * Where the canary folder is made. Under `$PAP_HOME` in the daemon (W5 carry 5): a folder of the read-only root, so the
   * probe exercises the tmpfs that hides the owner's home and `$PAP_HOME`, not only the one over `/tmp`.
   */
  readonly tmp?: string;
  /** Test seam for the spawn of the default probe. */
  readonly spawn?: typeof nodeSpawn;
  /**
   * The check `ensure` repeats on a usable result, before a launch: the real path when the binary is still the root-owned one
   * the probe found, else null. `trustedBinary` by default; a probe override (a test seam) skips it unless this is given.
   */
  readonly trusted?: (path: string) => string | null;
}

export function createSandboxProbe(options: SandboxProbeOptions): SandboxProbeService {
  const { clock, logger } = options;
  const probe =
    options.probe ??
    ((override) =>
      probeSandbox(override, {
        timers: clock,
        logger,
        ...(options.tmp ? { tmp: options.tmp } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
      }));
  const trusted =
    options.trusted ?? (options.probe ? (path: string) => path : (path: string) => trustedBinary(path));
  let last: CheckedProbe = { usable: false, reason: "missing", checkedAt: 0 };
  let logged: string | null = null;
  let inflight: Promise<SandboxProbe> | null = null;
  const run = async (): Promise<SandboxProbe> => {
    let result: SandboxProbe;
    try {
      result = await probe(options.override);
    } catch {
      result = { usable: false, reason: "refused" };
    }
    last = { ...result, checkedAt: clock.now() };
    const reason = result.usable ? null : result.reason;
    const key = `${result.usable}:${reason}`;
    if (key !== logged) {
      logged = key;
      logger.info("sandbox_probe", { usable: result.usable, reason });
    }
    return result;
  };
  const recheck = (): Promise<SandboxProbe> => {
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const strip = (checked: CheckedProbe): SandboxProbe =>
    checked.usable ? { usable: true, path: checked.path } : { usable: false, reason: checked.reason };
  return {
    current: () => last,
    recheck,
    ensure: () =>
      // A usable result is trusted only while its binary still is: a bwrap removed after boot is a fresh probe, not a failed command.
      (last.usable && trusted(last.path) === last.path) ||
      (!last.usable && last.checkedAt !== 0 && clock.now() - last.checkedAt <= PROBE_RETRY_MS)
        ? Promise.resolve(strip(last))
        : recheck(),
  };
}
