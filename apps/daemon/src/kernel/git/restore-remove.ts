import { lstat, rmdir, unlink } from "node:fs/promises";

const FORBIDDEN = new Set(["", ".", "..", ".git"]);

/**
 * Removes one file a restore made stale, and any folder that this leaves empty. `rel` is a latin1 string (the bytes of
 * a git path). It never follows a symlink: a folder on the way that is not a real folder ends the walk, and a folder is
 * never removed with its contents (`rmdir` refuses a folder that still holds a left-in-place file).
 */
export async function removeStale(root: string, rel: string): Promise<boolean> {
  const parts = rel.split("/");
  if (parts.some((part) => FORBIDDEN.has(part.toLowerCase()))) return false;
  const folders: Buffer[] = [Buffer.from(root)];
  for (const part of parts.slice(0, -1)) {
    const next = Buffer.concat([folders[folders.length - 1] as Buffer, Buffer.from(`/${part}`, "latin1")]);
    const info = await lstat(next).catch(() => null);
    if (info === null || !info.isDirectory()) return false;
    folders.push(next);
  }
  const file = Buffer.concat([
    folders[folders.length - 1] as Buffer,
    Buffer.from(`/${parts[parts.length - 1]}`, "latin1"),
  ]);
  const info = await lstat(file).catch(() => null);
  if (info === null || info.isDirectory()) return false;
  await unlink(file);
  for (let at = folders.length - 1; at >= 1; at -= 1) {
    try {
      await rmdir(folders[at] as Buffer);
    } catch {
      break; // not empty (a file was left in place) or already gone: the walk ends
    }
  }
  return true;
}
