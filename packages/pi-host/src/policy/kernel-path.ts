import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const MAX_LINK_HOPS = 40;
const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Where the kernel would land when it is handed `spelling` as is: `..` applies to the real directory reached so far,
 * after any symlink before it was followed (`/proc/self/root/..` is `/`, `link/..` is the parent of the link's
 * target), unlike `path.resolve`, which removes `..` first. Components that do not exist are appended as spelled.
 * Throws after too many links. Pi's own tools collapse `..` lexically (probed), so the policy judges both readings.
 */
export async function kernelResolve(cwd: string, spelling: string): Promise<string> {
  const pending = (isAbsolute(spelling) ? spelling : `${resolve(cwd)}${sep}${spelling}`).split(sep).reverse();
  let current: string = sep;
  let hops = 0;
  for (let segment = pending.pop(); segment !== undefined; segment = pending.pop()) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Nothing there: the rest is appended as spelled, `..` applied lexically.
      return resolve(next, ...pending.reverse().filter((rest) => rest !== ""));
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) throw new Error("too many symbolic links");
    const link = await readlink(next);
    if (isAbsolute(link)) current = sep;
    pending.push(...link.split(sep).reverse());
  }
  return current;
}
