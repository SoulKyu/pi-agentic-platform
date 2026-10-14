import { access, constants, lstat, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { decodeStrict, isMissing, MAX_POINTER_BYTES, pointer, present, readSmall } from "./git-fs.ts";

/**
 * Which repository would git use from a folder (M7 ruling MC7)? git's `is_git_directory` / `validate_headref` have
 * corners (a HEAD symlink, a 255-byte read, its own idea of a blank, `access(X_OK)` on `objects/` and `refs/`), and a
 * planted repository can sit in any of them. So this accepts only a strict subset of what git accepts, and any `.git`
 * entry or bare-looking folder it does not fully accept is "unresolvable": the command asks. The walk goes on to the
 * parent only when a folder has no `.git` entry and none of `HEAD`, `objects`, `refs`.
 */

export interface Repository {
  readonly gitDir: string;
  /** The folder whose `.git` named it, null for a bare repository. */
  readonly workTree: string | null;
}
export type Found = Repository | "none" | "unresolvable";

const MAX_HEAD_BYTES = 255;
const HEAD_REF = /^ref: refs\/[^\0\s]+\n?$/;
const HEAD_OBJECT = /^[0-9a-f]{40}\n?$/;
const GITFILE = /^gitdir: ([^\0\r\n]+)\n?$/;

const isFolder = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const searchable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return await isFolder(path);
  } catch {
    return false;
  }
};

async function headIsValid(head: string): Promise<boolean> {
  try {
    const info = await lstat(head);
    if (info.isSymbolicLink()) {
      if (!(await readlink(head)).startsWith("refs/")) return false;
      await stat(head);
      return true;
    }
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  const read = await readSmall(head, MAX_HEAD_BYTES);
  if (read === "missing" || read === "unreadable") return false;
  const text = read.bytes.toString("latin1");
  return HEAD_REF.test(text) || HEAD_OBJECT.test(text);
}

/** A git directory git certainly accepts: a valid HEAD, and `objects/` and `refs/` of its common directory. */
async function validGitDir(dir: string): Promise<boolean> {
  if (!(await headIsValid(join(dir, "HEAD")))) return false;
  const common = await pointer(join(dir, "commondir"), "", dir);
  if (common === null) return false;
  const shared = common === "missing" ? dir : common;
  return (await searchable(join(shared, "objects"))) && (await searchable(join(shared, "refs")));
}

async function viaGitfile(dotGit: string, folder: string): Promise<Found> {
  const read = await readSmall(dotGit, MAX_POINTER_BYTES);
  if (read === "missing" || read === "unreadable") return "unresolvable";
  const text = decodeStrict(read.bytes);
  const target = text === null ? undefined : GITFILE.exec(text)?.[1];
  if (target === undefined) return "unresolvable";
  const gitDir = await pointer(dotGit, "gitdir: ", folder);
  if (gitDir === null || gitDir === "missing") return "unresolvable";
  return (await isFolder(gitDir)) && (await validGitDir(gitDir))
    ? { gitDir, workTree: folder }
    : "unresolvable";
}

/** git's order in one folder: its `.git` (folder or gitfile), then the folder itself as a bare repository. */
export async function discover(folder: string): Promise<Found> {
  const dotGit = join(folder, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch (error) {
    // A dangling link is an entry git may care about: lstat tells it from nothing.
    if (!isMissing(error) || (await present(dotGit))) return "unresolvable";
  }
  if (info?.isFile()) return viaGitfile(dotGit, folder);
  if (info?.isDirectory())
    return (await validGitDir(dotGit)) ? { gitDir: dotGit, workTree: folder } : "unresolvable";
  if (info !== undefined) return "unresolvable";
  const bareLooking =
    (await present(join(folder, "HEAD"))) ||
    (await present(join(folder, "objects"))) ||
    (await present(join(folder, "refs")));
  if (!bareLooking) return "none";
  return (await validGitDir(folder)) ? { gitDir: folder, workTree: null } : "unresolvable";
}
