import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINK_HOPS = 40;
const UNICODE_SPACES = /\p{Zs}/gu;

// Pi rewrites a tool path before it opens the file (`~`, a leading `@`, file: URLs, unicode spaces).
// The policy must judge where the write really lands, so it follows the same rewrites.
function asPiResolves(path: string): string {
  const unprefixed = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  if (unprefixed === "~") return homedir();
  if (unprefixed.startsWith("~/")) return join(homedir(), unprefixed.slice(2));
  if (unprefixed.startsWith("file://")) return fileURLToPath(unprefixed);
  return unprefixed;
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

// realpath of the nearest existing ancestor plus the segments that do not exist yet, following dangling symlinks.
async function realTarget(path: string, hops = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if ((await lstatIfPresent(path))?.isSymbolicLink()) {
    if (hops >= MAX_LINK_HOPS) throw new Error("too many symbolic links");
    const directory = await realpath(dirname(path));
    return realTarget(resolve(directory, await readlink(path)), hops + 1);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error("no existing ancestor");
  return join(await realTarget(parent, hops), basename(path));
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Whether the file a tool call would write to is inside `cwd`. Both the literal reading of the path and
 * Pi's rewritten reading must stay inside once symlinks are resolved. Anything that is not a plain,
 * non-empty path string is outside.
 */
export async function isInsideCwd(path: unknown, cwd: string): Promise<boolean> {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
  const root = await realpath(cwd);
  for (const spelling of new Set([path, asPiResolves(path)])) {
    if (!within(root, await realTarget(resolve(cwd, spelling)))) return false;
  }
  return true;
}
