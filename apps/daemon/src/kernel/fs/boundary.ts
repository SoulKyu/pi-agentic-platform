import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isProtectedName } from "@pap/contracts";

export const MAX_PATH_BYTES = 4096;
/** Pseudo-filesystems and runtime folders hold process secrets and are never project content: a token never sees them (MC7). */
export const TOKEN_HIDDEN_DIRS = ["/proc", "/sys", "/dev", "/run"] as const;
/** Pi's configuration and credentials: M7's Settings is their only reader and writer (agreement 6, M8R16). */
export const PI_CONFIG_FILES = [
  "auth.json",
  "models.json",
  "mcp.json",
  "trust.json",
  "settings.json",
] as const;

export interface BoundaryConfig {
  /** `$PAP_HOME` as configured and as it resolves: a link on either side cannot hide it. */
  readonly papHome: readonly string[];
  /** Pi's agent directory, both spellings. */
  readonly agentDir: readonly string[];
  /** The daemon's home folder, both spellings: a root at or above it protects home's dot-entries (M8R16, owner f8). */
  readonly home: readonly string[];
  /** Folders under `$PAP_HOME` the owner may browse: none in M8 (M9 adds `worktrees`, R97). */
  readonly papHomeOpen: readonly string[];
  /** `$XDG_RUNTIME_DIR` when set, both spellings: hidden from tokens with `/run` (MC7). The judge never reads the environment. */
  readonly runtimeDirs: readonly string[];
}

/**
 * The boundary of a box: none of the host's folders is in it (pap's home, Pi's, the daemon's home), so the pure name rules
 * judge a box path as a name alone, relative to the project folder. A host path must never decide for a box path: in the
 * process backend (tests) the box sits under `$PAP_HOME` on this machine, and the host's judge would refuse all of it.
 */
export const NO_HOST_BOUNDARY: BoundaryConfig = {
  papHome: [],
  agentDir: [],
  home: [],
  papHomeOpen: [],
  runtimeDirs: [],
};

/**
 * A box path's name alone (`rooted`: relative to the project folder, with its leading slash), judged under a neutral prefix: the
 * host-only names (`/dev`, `/run`, `/proc`, `/sys`) guard the host's root, so a project's own `dev/` or `run/` folder is not one of them.
 */
export function judgeBoxName(rooted: string, caller: CallerKind): NameRefusal | null {
  return judgeName(`/project${rooted}`, { roots: [], config: NO_HOST_BOUNDARY, caller });
}

export type Intent = "list" | "read" | "write";
export type CallerKind = "session" | "token";
/** What a write needs (M8R16, M8R101): nothing, the "Save anyway?" confirmation, or the confirmation and a live step-up. */
export type Protection = "none" | "confirm" | "step_up";
export type NameRefusal = "pap_home" | "pi_private" | "token_hidden";
export type Refusal = "malformed" | "outside" | "missing" | NameRefusal;

/** Who asks, and where they may look: every judgement and every re-judgement of a descriptor takes it. */
export interface Scope {
  readonly roots: readonly string[];
  readonly config: BoundaryConfig;
  readonly caller: CallerKind;
}

export type Judgement =
  | {
      readonly ok: true;
      /** Where the path really leads; for a new file, or a link that dangles, its real folder plus its name. */
      readonly real: string;
      /** The root that holds `real`. */
      readonly root: string;
      readonly protection: Protection;
      readonly exists: boolean;
    }
  | { readonly ok: false; readonly why: Refusal };

export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Absolute, no empty, `.` or `..` segment, no NUL, at most 4 096 bytes (M8R14). */
export function canonical(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return false;
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const segmentsOf = (path: string): string[] =>
  path
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.normalize("NFC").toLowerCase());

/** `~/.bashrc`, `~/.ssh/id_ed25519`, `~/.config/x`, when one of the caller's roots is home or above it (owner f8). */
function homeDotEntry(candidate: string, scope: Scope): boolean {
  return scope.config.home.some(
    (home) =>
      candidate !== home &&
      within(home, candidate) &&
      relative(home, candidate).startsWith(".") &&
      scope.roots.some((root) => within(root, home)),
  );
}

const inAgentDir = (candidate: string, config: BoundaryConfig): boolean =>
  config.agentDir.some((dir) => within(dir, candidate));

/** The refusals that need no filesystem, for one spelling (M8R16, M8R102): pap's data, Pi's private files, what a token never sees. */
export function judgeName(candidate: string, scope: Scope): NameRefusal | null {
  const { config } = scope;
  const papHome = config.papHome.some(
    (home) =>
      within(home, candidate) && !config.papHomeOpen.some((open) => within(join(home, open), candidate)),
  );
  if (papHome) return "pap_home";
  const piPrivate = config.agentDir.some(
    (dir) =>
      within(join(dir, "sessions"), candidate) ||
      PI_CONFIG_FILES.some((name) => candidate === join(dir, name)),
  );
  if (piPrivate) return "pi_private";
  if (scope.caller !== "token") return null;
  const runtime = [...TOKEN_HIDDEN_DIRS, ...config.runtimeDirs].some((dir) => within(dir, candidate));
  if (runtime) return "token_hidden";
  const segments = segmentsOf(candidate);
  const last = segments.at(-1) ?? "";
  const mcpList = last === ".mcp.json" || (last === "mcp.json" && segments.at(-2) === ".pi");
  return mcpList || inAgentDir(candidate, config) || homeDotEntry(candidate, scope) ? "token_hidden" : null;
}

const RANK: Readonly<Record<Protection, number>> = { none: 0, confirm: 1, step_up: 2 };

/** What a write to this spelling needs (M8R16, owner c3): Pi's folders the step-up, M5's names and home's dot-entries a confirmation. */
export function protectionOf(candidate: string, scope: Scope): Protection {
  if (inAgentDir(candidate, scope.config) || segmentsOf(candidate).includes(".pi")) return "step_up";
  return isProtectedName(candidate) || homeDotEntry(candidate, scope) ? "confirm" : "none";
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function landing(path: string, intent: Intent): Promise<{ real: string; exists: boolean } | null> {
  const real = await realOrNull(path);
  if (real !== null) return { real, exists: true };
  if (intent !== "write") return null;
  const folder = await realOrNull(dirname(path));
  return folder === null ? null : { real: join(folder, basename(path)), exists: false };
}

export async function judgePath(path: unknown, scope: Scope, intent: Intent): Promise<Judgement> {
  if (!canonical(path)) return { ok: false, why: "malformed" };
  const target = await landing(path, intent);
  if (target === null) return { ok: false, why: "missing" };
  const { real, exists } = target;
  const root = scope.roots.find((candidate) => within(candidate, real));
  if (root === undefined || !scope.roots.some((candidate) => within(candidate, path)))
    return { ok: false, why: "outside" };
  const refused = judgeName(path, scope) ?? judgeName(real, scope);
  if (refused !== null) return { ok: false, why: refused };
  const spelled = protectionOf(path, scope);
  const landed = protectionOf(real, scope);
  return { ok: true, real, root, protection: RANK[spelled] >= RANK[landed] ? spelled : landed, exists };
}

/** A listing shows an entry the caller may not open as `protected: true`, never browsable (M8R25). */
export function entryIsProtected(candidate: string, scope: Scope): boolean {
  return judgeName(candidate, scope) !== null;
}

export type WriteGate = "ok" | "forbidden" | "protected_path" | "step_up_required";

/** M8R101 (RT-03, agreement 5, owner c3): tokens never write a protected file nor confirm; the owner confirms, and steps up for Pi's folders. */
export function gateWrite(input: {
  readonly protection: Protection;
  readonly caller: { readonly kind: CallerKind; readonly stepUpUntil: number };
  readonly confirmProtected: boolean;
  readonly now: number;
}): WriteGate {
  if (input.caller.kind === "token")
    return input.confirmProtected || input.protection !== "none" ? "forbidden" : "ok";
  if (input.protection === "none") return "ok";
  if (!input.confirmProtected) return "protected_path";
  if (input.protection === "step_up" && input.caller.stepUpUntil <= input.now) return "step_up_required";
  return "ok";
}
