import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export interface SafeTreeLimits {
  /** Bytes copied in all, counted while reading: a file that grows during the copy stops it (RT-13). */
  readonly maxBytes: number;
  readonly maxEntries: number;
}
export type SafeTreeError = "link" | "special" | "owner" | "too_large" | "too_many" | "missing" | "changed";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
const at = (dirFd: number, name: string): string => `/proc/self/fd/${dirFd}/${name}`;
const MAX_LINK_TEXT = 4096;
const CHUNK = 64 * 1024;

class Stop extends Error {
  readonly reason: SafeTreeError;
  constructor(reason: SafeTreeError) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * R3, R7, RT-13: pap-vmd copies a tree pap's user owns (and can change while it is read) into a folder of its own. Every
 * entry is looked at and opened relative to its parent's descriptor (`/proc/self/fd/<fd>/<name>`) with O_NOFOLLOW, so a link
 * swapped in at any level is never followed. Links are recreated as links (their text, never their target; how
 * `mkfs.ext4 -d` and BuildKit handle a link is to be checked by T20a); folders and regular files owned by `uid` are copied
 * with modes masked to 0755/0644 (no setuid, setgid or sticky bit); anything else stops the copy. Bytes are counted as they
 * are read. The source's own path above its last component is followed: harmless, since every entry must still belong to
 * `uid`. A leftover target from an interrupted copy is removed first. On any refusal the partial target is removed.
 */
export function copyTreeSafely(
  source: string,
  target: string,
  uid: number,
  limits: SafeTreeLimits,
): SafeTreeError | null {
  let rootFd: number;
  try {
    rootFd = openSync(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "link";
  }
  rmSync(target, { recursive: true, force: true });
  const totals = { bytes: 0, entries: 0 };
  try {
    copyDir(rootFd, target, uid, limits, totals);
    return null;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (error instanceof Stop) return error.reason;
    throw error;
  } finally {
    closeSync(rootFd);
  }
}

/** An entry that vanished or changed kind between two looks at it stops the copy as `changed`, never as a crash. */
function settled<T>(look: () => T): T {
  try {
    return look();
  } catch {
    throw new Stop("changed");
  }
}

function openEntry(where: string, flags: number): number {
  try {
    return openSync(where, flags | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    // The entry was a file or folder a moment ago: gone, or a link swapped in since (ELOOP), or no longer a folder.
    const code = (error as NodeJS.ErrnoException).code;
    throw new Stop(code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR" ? "changed" : "special");
  }
}

function copyDir(
  dirFd: number,
  target: string,
  uid: number,
  limits: SafeTreeLimits,
  totals: { bytes: number; entries: number },
): void {
  const stat = fstatSync(dirFd);
  if (!stat.isDirectory()) throw new Stop("changed");
  if (stat.uid !== uid) throw new Stop("owner");
  mkdirSync(target, { mode: 0o755 });
  for (const name of readdirSync(`/proc/self/fd/${dirFd}`)) {
    if (++totals.entries > limits.maxEntries) throw new Stop("too_many");
    const entry = settled(() => lstatSync(at(dirFd, name)));
    if (entry.uid !== uid) throw new Stop("owner");
    const into = path.join(target, name);
    if (entry.isSymbolicLink()) {
      const text = settled(() => readlinkSync(at(dirFd, name)));
      if (text.length === 0 || text.length > MAX_LINK_TEXT || text.includes("\0")) throw new Stop("special");
      symlinkSync(text, into);
    } else if (entry.isDirectory()) {
      const fd = openEntry(at(dirFd, name), O_RDONLY | O_DIRECTORY);
      try {
        copyDir(fd, into, uid, limits, totals);
      } finally {
        closeSync(fd);
      }
    } else if (entry.isFile()) {
      const fd = openEntry(at(dirFd, name), O_RDONLY);
      try {
        copyFile(fd, into, uid, limits, totals);
      } finally {
        closeSync(fd);
      }
    } else {
      throw new Stop("special");
    }
  }
}

function copyFile(
  fd: number,
  into: string,
  uid: number,
  limits: SafeTreeLimits,
  totals: { bytes: number },
): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Stop("changed");
  if (stat.uid !== uid) throw new Stop("owner");
  const out = openSync(
    into,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
    (stat.mode & 0o111) !== 0 ? 0o755 : 0o644,
  );
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const room = limits.maxBytes - totals.bytes;
      // One byte past the budget is enough to know the file does not fit.
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, room + 1), null);
      if (n === 0) return;
      if (n > room) throw new Stop("too_large");
      totals.bytes += n;
      for (let done = 0; done < n;) done += writeSync(out, chunk, done, n - done);
    }
  } finally {
    closeSync(out);
  }
}
