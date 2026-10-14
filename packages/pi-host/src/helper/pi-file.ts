import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { within } from "../policy/target-path.ts";

export const MAX_PI_FILE_BYTES = 1024 * 1024;
export type PiFileReason = "link-outside" | "link-dangling" | "not-a-file" | "too-large" | "hard-link";
export class PiFileRefused extends Error {
  readonly reason: PiFileReason;
  constructor(reason: PiFileReason) {
    super(reason);
    this.name = "PiFileRefused";
    this.reason = reason;
  }
}
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** A path that does not exist yet (a new `.pi/mcp.json`): its nearest existing ancestor's real path, then the rest as spelled. */
async function realOfMissing(path: string): Promise<string> {
  const rest = [basename(path)];
  for (let base = dirname(resolve(path)); ; base = dirname(base)) {
    try {
      return join(await fs.realpath(base), ...[...rest].reverse());
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      if ((await fs.lstat(base).catch(() => null))?.isSymbolicLink())
        throw new PiFileRefused("link-dangling");
    }
    if (dirname(base) === base) return resolve(path);
    rest.push(basename(base));
  }
}

/** The roots as real paths, resolved once per call: a later swap of a root cannot move the list the checks use. */
async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  const real: string[] = [];
  for (const root of roots) {
    const resolved = await fs.realpath(root).catch(() => resolve(root));
    // The real path decides: `//`, `/.`, `/tmp/..` and a link to `/` all name the filesystem root, which is never a root.
    if (!isAbsolute(root) || dirname(resolved) === resolved) throw new PiFileRefused("link-outside");
    real.push(resolved);
  }
  return real;
}

const insideRoots = (real: string, roots: readonly string[]): boolean =>
  roots.some((root) => within(root, real));

/** M7R40b: the real file a Pi config path names, which must lie inside one of `roots` (real paths). */
async function locate(
  path: string,
  given: readonly string[],
): Promise<{ real: string; exists: boolean; roots: readonly string[] }> {
  const roots = await resolveRoots(given);
  let real: string;
  let exists = true;
  try {
    real = await fs.realpath(path);
  } catch (error) {
    if (code(error) === "ELOOP") throw new PiFileRefused("link-dangling");
    if (code(error) !== "ENOENT") throw error;
    if ((await fs.lstat(path).catch(() => null))?.isSymbolicLink()) throw new PiFileRefused("link-dangling");
    real = await realOfMissing(path);
    exists = false;
  }
  if (!insideRoots(real, roots)) throw new PiFileRefused("link-outside");
  return { real, exists, roots };
}

/**
 * A folder swapped for a link between `locate` and the open is caught here: on Linux the kernel names the file the
 * descriptor really is, and that name must lie inside the roots `locate` resolved (not re-resolved now, so swapping a
 * root itself is caught too). A name that cannot be read fails closed.
 * Other platforms keep only the check made by `locate` (the helper runs on Linux).
 */
async function judgeDescriptor(fd: number, roots: readonly string[]): Promise<void> {
  if (process.platform !== "linux") return;
  const opened = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => null);
  if (opened === null || !insideRoots(opened, roots)) throw new PiFileRefused("link-outside");
}

/** Reads a Pi config file once: no final link followed, no FIFO waited on, a regular file of at most 1 MiB. */
export async function readPiFile(
  path: string,
  given: readonly string[],
): Promise<{ text: string | null; real: string; mode: number | null }> {
  const { real, exists, roots } = await locate(path, given);
  if (!exists) return { text: null, real, mode: null };
  const handle = await fs
    .open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
    .catch((error: unknown) => {
      throw code(error) === "ENXIO" ? new PiFileRefused("not-a-file") : error;
    });
  try {
    await judgeDescriptor(handle.fd, roots);
    const info = await handle.stat();
    if (!info.isFile()) throw new PiFileRefused("not-a-file");
    if (info.size > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
    const buffer = Buffer.allocUnsafe(MAX_PI_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
    return { text: buffer.toString("utf8", 0, length), real, mode: info.mode & 0o777 };
  } finally {
    // A close error must not replace a refusal; a read-only descriptor has nothing to lose.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Replaces a Pi config file atomically: an exclusive private file beside the real one, then chmod, rename and a folder sync.
 * Residuals: another process of the same user can still swap a folder between the descriptor check and the rename,
 * and a folder planted as a link just before `mkdir` leaves empty folders outside the roots (the file itself is refused).
 * A target with another hard link is refused (`hard-link`): the rename would split the link and the other name would keep the old text.
 * Residual: that check and the rename are not one step, so a hard link made by another process of the same user in
 * between is split by the rename (the other name keeps the old text). A folder sync that fails after the rename does
 * not fail the write (the new file is already in place): `onFolderSyncFailed` receives the error code, once.
 */
export async function writePiFile(
  path: string,
  text: string,
  options: {
    readonly roots: readonly string[];
    readonly mode: number;
    readonly keepMode: boolean;
    readonly onFolderSyncFailed?: (code: string) => void;
  },
): Promise<void> {
  if (Buffer.byteLength(text) > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
  const { real, exists, roots } = await locate(path, options.roots);
  let mode = options.mode;
  if (exists) {
    const info = await fs.lstat(real);
    if (!info.isFile()) throw new PiFileRefused("not-a-file");
    if (info.nlink > 1) throw new PiFileRefused("hard-link");
    if (options.keepMode) mode = info.mode & 0o777;
  } else await fs.mkdir(dirname(real), { recursive: true, mode: 0o755 });
  const temp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY,
    0o600,
  );
  try {
    try {
      await judgeDescriptor(handle.fd, roots);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.chmod(mode);
    } catch (error) {
      await handle.close().catch(() => undefined); // the original error is the one the caller needs
      throw error;
    }
    await handle.close();
    await fs.rename(temp, real);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined); // the original error is the one the caller needs
    throw error;
  }
  await syncFolder(dirname(real), options.onFolderSyncFailed);
}

/** After the rename the write is done: a folder that cannot be synced only means the rename may not survive a power cut. */
async function syncFolder(folder: string, onFailed: ((code: string) => void) | undefined): Promise<void> {
  try {
    const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    onFailed?.(code(error) ?? "UNKNOWN");
  }
}
