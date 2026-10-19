import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { inside, type VmFileRoots } from "../policy/vm-paths.ts";

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
/** Pi's read loads a whole file; past this the model is told to use the shell (`head`, `tail`). */
export const VM_READ_MAX_BYTES = 64 * 1024 * 1024;
const at = (dirFd: number, name: string): string => `/proc/self/fd/${dirFd}/${name}`;

const OUTSIDE_OR_LINK =
  "pap: outside this agent's folders, or a link (Pi's file tools never follow links in a VM; the shell can)";

/** A refused call. The default message is for a path outside the folders, a link or a file that is not a regular one; size and missing have their own. */
export class VmFileRefused extends Error {
  constructor(message: string = OUTSIDE_OR_LINK) {
    super(message);
  }
}

/** The root `absolute` lies under and the components below it; null outside every root or for a spelling with `.`, `..` or `//`. */
function split(absolute: string, roots: readonly string[]): { root: string; parts: string[] } | null {
  if (!path.isAbsolute(absolute) || absolute.includes("\0")) return null;
  const root = roots.find((each) => inside(absolute, each));
  if (root === undefined) return null;
  const parts = absolute === root ? [] : absolute.slice(root.length + 1).split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? null : { root, parts };
}

/** What a refused open says: a missing path and a link are different answers; a system error (EMFILE, ENOSPC...) is passed on as it is. */
function refusalOf(error: unknown): unknown {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return new VmFileRefused("pap: no such file");
    case "ELOOP":
    case "ENOTDIR":
    case "ENXIO":
    case "EISDIR":
    case "EACCES":
    case "EPERM":
      return new VmFileRefused();
    default:
      return error;
  }
}

function openNoFollow(where: string, flags: number): number {
  try {
    // O_NONBLOCK: a FIFO the shell planted opens at once and is refused below by its type, never waited on.
    return openSync(where, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  } catch (error) {
    throw refusalOf(error);
  }
}

/**
 * RT-01: what `absolute` names under one of `roots`, opened one component at a time relative to the folder before it
 * (`/proc/self/fd/<fd>/<name>`), each with O_NOFOLLOW: a link anywhere, planted before or during the call, is refused.
 * `create` makes missing folders (0755) on the way. Roots are trusted real folders (`realVmRoots`).
 */
function openPath(absolute: string, roots: readonly string[], leafFlags: number, create = false): number {
  const where = split(absolute, roots);
  if (where === null) throw new VmFileRefused();
  let fd = openNoFollow(where.root, O_RDONLY | O_DIRECTORY);
  where.parts.forEach((name, i) => {
    const last = i === where.parts.length - 1;
    try {
      if (create) {
        try {
          mkdirSync(at(fd, name), { mode: 0o755 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw refusalOf(error);
        }
      }
      const next = openNoFollow(at(fd, name), last ? leafFlags : O_RDONLY | O_DIRECTORY);
      closeSync(fd);
      fd = next;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  });
  return fd;
}

function withFd<T>(fd: number, use: (fd: number) => T): T {
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}
const regular = (fd: number): number => {
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new VmFileRefused();
  }
  return fd;
};

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks, total);
    total += n;
    if (total > VM_READ_MAX_BYTES)
      throw new VmFileRefused(
        `pap: file over ${VM_READ_MAX_BYTES} bytes: read it with the shell (head, sed -n)`,
      );
    chunks.push(chunk.subarray(0, n));
  }
}

const IMAGE_MAGIC: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
];
function imageType(fd: number): string | null {
  const head = Buffer.alloc(12);
  const n = readSync(fd, head, 0, 12, 0);
  const found = IMAGE_MAGIC.find(
    ([, magic]) => n >= magic.length && magic.every((byte, i) => head[i] === byte),
  );
  if (found) return found[0];
  const webp =
    n === 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  return webp ? "image/webp" : null;
}

/** Pi's `ReadOperations`, `WriteOperations`, `EditOperations` and `LsOperations` for a VM agent (spec §5, RT-01). */
export function createVmFileOps(roots: VmFileRoots) {
  const readable = [...roots.writable, ...roots.readOnly];
  const readFile = async (absolute: string): Promise<Buffer> =>
    withFd(regular(openPath(absolute, readable, O_RDONLY)), readAll);
  const writeFile = async (absolute: string, content: string): Promise<void> =>
    withFd(regular(openPath(absolute, roots.writable, O_WRONLY | O_CREAT | O_TRUNC)), (fd) => {
      const bytes = Buffer.from(content, "utf8");
      for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
    });
  const accessIn =
    (list: readonly string[]) =>
    async (absolute: string): Promise<void> =>
      withFd(regular(openPath(absolute, list, O_RDONLY)), () => undefined);
  return {
    read: {
      readFile,
      access: accessIn(readable),
      detectImageMimeType: async (absolute: string) =>
        withFd(regular(openPath(absolute, readable, O_RDONLY)), imageType),
    },
    write: {
      writeFile,
      mkdir: async (dir: string): Promise<void> => {
        closeSync(openPath(dir, roots.writable, O_RDONLY | O_DIRECTORY, true));
      },
    },
    edit: { readFile, writeFile, access: accessIn(roots.writable) },
    ls: {
      exists: (absolute: string): boolean => {
        try {
          closeSync(openPath(absolute, readable, O_RDONLY));
          return true;
        } catch {
          return false;
        }
      },
      // The entry itself, never what it points to: a link or a socket in a listed folder shows as a non-folder.
      stat: (absolute: string) => {
        const where = split(absolute, readable);
        if (where === null) throw new VmFileRefused();
        const directory =
          where.parts.length === 0
            ? withFd(openPath(absolute, readable, O_RDONLY | O_DIRECTORY), () => true)
            : withFd(openPath(path.dirname(absolute), readable, O_RDONLY | O_DIRECTORY), (fd) =>
                lstatSync(at(fd, path.basename(absolute))).isDirectory(),
              );
        return { isDirectory: () => directory };
      },
      readdir: (absolute: string): string[] =>
        withFd(openPath(absolute, readable, O_RDONLY | O_DIRECTORY), (fd) =>
          readdirSync(`/proc/self/fd/${fd}`),
        ),
    },
  };
}
