import { constants } from "node:fs";
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import { kernelResolve } from "./kernel-path.ts";

/** Filesystem reads shared by the git config guard and its repository discovery. */

export const MAX_POINTER_BYTES = 4096;

export type Read = { readonly bytes: Buffer } | "missing" | "unreadable";

export const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * A small regular file, links followed as git follows them; a FIFO or a device is never opened for a blocking read.
 * At most `size + 1` bytes are read (`size` is at most `max`), so a file that grows after the size check is not read in full.
 */
export async function readSmall(path: string, max: number): Promise<Read> {
  let handle: FileHandle;
  try {
    if (!(await stat(path)).isFile()) return "unreadable";
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return isMissing(error) ? "missing" : "unreadable";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return "unreadable";
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    // More bytes than the size said: the file grew while it was read.
    return length > info.size ? "unreadable" : { bytes: buffer.subarray(0, length) };
  } catch {
    return "unreadable";
  } finally {
    await handle.close();
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * File bytes as text, or null when they are not valid UTF-8. git uses the raw bytes of a path; a lossy decode would
 * turn an invalid byte into U+FFFD and name a different path, so such a file asks (M7 ruling MC10).
 */
export function decodeStrict(bytes: Buffer): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** Whether anything (a dangling link included) is at `path`; an error other than "missing" counts as present. */
export async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

/** The folder a `.git` file (`gitdir: <path>`) or a `commondir` file names, as git resolves it from `from`. */
export async function pointer(
  path: string,
  prefix: string,
  from: string,
): Promise<string | null | "missing"> {
  const read = await readSmall(path, MAX_POINTER_BYTES);
  if (read === "missing") return "missing";
  if (read === "unreadable") return null;
  const decoded = decodeStrict(read.bytes);
  if (decoded === null) return null;
  const text = decoded.replace(/[\r\n]+$/, "");
  if (!text.startsWith(prefix)) return null;
  const target = text.slice(prefix.length);
  if (target === "" || /[\0\n]/.test(target)) return null;
  try {
    return await kernelResolve(from, target);
  } catch {
    return null;
  }
}
