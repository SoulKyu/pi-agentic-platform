import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link as linkPath, lstat, open, readlink, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { judgeName, type Scope, within } from "./boundary.ts";
import type { DenySet } from "./deny-set.ts";

export type BoundaryReason = "not_regular" | "moved" | "denied" | "too_large" | "exists";

export class BoundaryError extends Error {
  readonly reason: BoundaryReason;

  constructor(reason: BoundaryReason) {
    super(reason);
    this.name = "BoundaryError";
    this.reason = reason;
  }
}

/** What must still hold once a descriptor exists (M8R17): the judged root, no refused name, no private inode. */
export interface OpenGuard extends Scope {
  readonly root: string;
  readonly deny: DenySet;
}

/** Never a controlling terminal: opening a pty slave must not tie it to the daemon's session (SIGHUP stops pap). */
export const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
export const FOLDER_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NOCTTY;
export const TEMP_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY;

/** Tier 1 (Linux) always has /proc: a descriptor whose place cannot be read is refused. Tier 2 checks the name only. */
const PROC_EXPECTED = process.platform === "linux";

/** Where an open descriptor really is (Linux /proc); null only where /proc is not expected. */
async function descriptorPath(handle: FileHandle): Promise<string | null> {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    if (PROC_EXPECTED) throw new BoundaryError("moved");
    return null;
  }
}

/**
 * The full name judgement again, on where the descriptor landed (a folder swapped for a link meanwhile).
 * `name` replaces the last segment: a temporary file is judged as the file it will become.
 */
async function checkPlace(handle: FileHandle, guard: OpenGuard, name?: string): Promise<string | null> {
  const where = await descriptorPath(handle);
  if (where === null) return null;
  const candidate = name === undefined ? where : join(dirname(where), name);
  if (!within(guard.root, candidate) || judgeName(candidate, guard) !== null)
    throw new BoundaryError("moved");
  return where;
}

async function checkDescriptor(handle: FileHandle, guard: OpenGuard, name?: string): Promise<void> {
  await checkPlace(handle, guard, name);
  if (await guard.deny.has(await handle.stat({ bigint: true }))) throw new BoundaryError("denied");
}

/** A regular file the boundary accepted, opened for reading (M8R17). The caller closes it. */
export async function openRegularFile(real: string, guard: OpenGuard): Promise<FileHandle> {
  const handle = await open(real, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new BoundaryError("not_regular");
    await checkDescriptor(handle, guard);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** A folder the boundary accepted, held open while it is listed (M8R104, RT-15): read it through `path`, then `close`. */
export async function openFolder(
  real: string,
  guard: OpenGuard,
): Promise<{ readonly path: string; close(): Promise<void> }> {
  const handle = await open(real, FOLDER_FLAGS);
  try {
    const where = await checkPlace(handle, guard);
    return { path: where === null ? real : `/proc/self/fd/${handle.fd}`, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export interface AtomicWrite {
  readonly real: string;
  readonly guard: OpenGuard;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly maxBytes: number;
  /** The existing file's mode, or `0o666 & ~workerUmask` for a new one (R114). */
  readonly mode: number;
  /** False: an existing target at rename time is `exists`, never replaced. */
  readonly replace: boolean;
}

/** Errors of `link` on a filesystem without hard links (vfat, some FUSE or CIFS mounts). */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

async function placeNew(temp: string, real: string, link: typeof linkPath): Promise<void> {
  try {
    await link(temp, real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw new BoundaryError("exists");
    if (!NO_HARD_LINKS.has(code)) throw error;
    // M8R18 (RT-39): check, then rename. A file created between the two is replaced (residual, files.md).
    const taken = await lstat(real).then(
      () => true,
      () => false,
    );
    if (taken) throw new BoundaryError("exists");
    await rename(temp, real);
    return;
  }
  // The file exists now: a temporary name that stays behind is not worth failing the write for.
  await unlink(temp).catch(() => undefined);
}

/** Makes the rename durable. Best effort: the file is already in place, a failure here cannot undo that. */
async function syncFolder(folder: string): Promise<void> {
  try {
    const handle = await open(folder, FOLDER_FLAGS);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // some filesystems refuse fsync on a directory
  }
}

/** M8R18. Returns the bytes written; leaves no temporary file behind on any path. `link` is a seam for RT-39's test. */
export async function writeAtomic(input: AtomicWrite, link: typeof linkPath = linkPath): Promise<number> {
  const temp = join(dirname(input.real), `.pap-${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, TEMP_FLAGS, 0o600);
  let closed = false;
  try {
    await checkDescriptor(handle, input.guard, basename(input.real));
    await handle.chmod(input.mode);
    let total = 0;
    for await (const chunk of input.chunks) {
      total += chunk.byteLength;
      if (total > input.maxBytes) throw new BoundaryError("too_large");
      for (let done = 0; done < chunk.byteLength;) {
        done += (await handle.write(chunk, done, chunk.byteLength - done)).bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    closed = true;
    // A private file under another name (a hard link, a case-insensitive spelling) is never replaced either.
    const target = await lstat(input.real, { bigint: true }).catch(() => null);
    if (target !== null && (await input.guard.deny.has(target))) throw new BoundaryError("denied");
    if (input.replace) await rename(temp, input.real);
    else await placeNew(temp, input.real, link);
    await syncFolder(dirname(input.real));
    return total;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export const isTempName = (name: string): boolean => /^\.pap-[0-9a-f]{12}\.tmp$/.test(basename(name));
