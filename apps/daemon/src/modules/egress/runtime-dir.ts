import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Logger } from "../../kernel/logger.ts";

/** `sun_path` holds 107 bytes; the longest socket is `<root>/<session key>/<command key>.s`, keys of at most 6 characters. */
const MAX_SOCKET_BYTES = 107;
const LONGEST_SUFFIX = "/xxxxxx/xxxxxx.s";
const PAP_FOLDER = /^[0-9a-z]{1,6}$/;
const PAP_SOCKET = /^[0-9a-z]{1,6}\.s$/;
const FORWARDER_FILE = /^fwd\.py(?:\.[0-9a-f]+\.tmp)?$/;

export interface RootChoice {
  readonly runtimeDir: string | undefined;
  readonly papHome: string;
  /** The daemon's user; `process.getuid()` by default. */
  readonly uid?: number | undefined;
}

/** Six hex digits naming this daemon's data folder: two daemons on one `XDG_RUNTIME_DIR` get two roots (W5-R42). */
export function daemonKey(papHome: string): string {
  let real = papHome;
  try {
    real = realpathSync(papHome);
  } catch {
    // a home that does not exist yet keeps its given spelling
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 6);
}

const fits = (root: string): boolean => Buffer.byteLength(root + LONGEST_SUFFIX) <= MAX_SOCKET_BYTES;

/** A folder the daemon's user alone can use: not a link, owned by it, mode 0700 (the XDG runtime folder's contract). */
function privateFolder(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/**
 * `$XDG_RUNTIME_DIR/pap/<daemon key>/egress` when that runtime folder is private to the daemon's user, else `$PAP_HOME/run/egress`; the
 * first whose longest socket path fits 107 bytes. Null when neither does (M11R234).
 */
export function chooseRoot({
  runtimeDir,
  papHome,
  uid = process.getuid?.() ?? 0,
}: RootChoice): string | null {
  const candidates: string[] = [];
  if (runtimeDir && isAbsolute(runtimeDir) && privateFolder(runtimeDir, uid))
    candidates.push(join(runtimeDir, "pap", daemonKey(papHome), "egress"));
  candidates.push(join(papHome, "run", "egress"));
  return candidates.find(fits) ?? null;
}

/** Why a root could not be made, for the boot log: `reason` is one of these words. */
export type RootReason = "outside_base" | "link" | "not_a_folder" | "not_ours" | "io";
const rootError = (reason: RootReason, cause?: unknown): Error =>
  Object.assign(new Error(`egress root: ${reason}`, { cause }), { reason });
/** The reason carried by an error from `prepareRoot`. */
export const rootReasonOf = (error: unknown): RootReason =>
  typeof error === "object" && error !== null && "reason" in error
    ? (error as { reason: RootReason }).reason
    : "io";

/** Makes one folder 0700 without following a link: `lstat` before, then `open` with O_NOFOLLOW and `fchmod` on the handle. */
function privateDir(path: string): void {
  let stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink()) throw rootError("link");
  if (!stat.isDirectory()) throw rootError("not_a_folder");
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).uid !== (process.getuid?.() ?? 0)) throw rootError("not_ours");
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/** Makes every folder from `base` (which must exist) down to the root 0700. Throws on a link or a foreign owner. */
export function prepareRoot(root: string, base: string): void {
  const steps = relative(base, root).split(sep);
  if (steps[0] === ".." || isAbsolute(steps[0] ?? "")) throw rootError("outside_base");
  let path = base;
  for (const step of steps) {
    path = join(path, step);
    privateDir(path);
  }
}

/** One folder per agent session, named by its key (a per-daemon counter in base 36). */
export function sessionFolder(root: string, key: string): string {
  const folder = join(root, key);
  privateDir(folder);
  return folder;
}

export function dropFolder(root: string, key: string): void {
  rmSync(join(root, key), { recursive: true, force: true });
}

/**
 * At boot: removes what pap made under the root and a dead daemon left (folders of base-36 names, `*.s` sockets and the
 * forwarder), never following a link. Anything else is left in place with one warning carrying the count.
 */
export function bootClean(root: string, logger: Logger): void {
  let foreign = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && PAP_FOLDER.test(entry.name)) rmSync(path, { recursive: true, force: true });
    else if (
      (entry.isSocket() || entry.isFile()) &&
      (PAP_SOCKET.test(entry.name) || FORWARDER_FILE.test(entry.name))
    ) {
      unlinkSync(path);
    } else foreign += 1;
  }
  if (foreign > 0) logger.warn("egress_boot_foreign", { count: foreign });
}
