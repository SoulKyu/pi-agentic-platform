import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LaneId } from "@pap/contracts";
import { isLaneGitDir } from "../../kernel/git/exec.ts";

export const WORKTREES_DIR = "worktrees";

export function laneFolder(papHome: string, laneId: string): string {
  if (!LaneId.safeParse(laneId).success) throw new Error("not a lane id");
  return join(realpathSync(papHome), WORKTREES_DIR, laneId);
}

/**
 * Removes a lane's folder that git no longer knows. Only a direct child of the real worktrees folder, named like a lane,
 * and not a symlink; anything else is refused (logged by the caller). `rm` unlinks links inside, never follows them,
 * and runs off the event loop (a whole checkout, M9-RT-12).
 */
export async function removeLaneFolder(papHome: string, path: string): Promise<boolean> {
  const root = join(realpathSync(papHome), WORKTREES_DIR);
  if (dirname(path) !== root || !LaneId.safeParse(basename(path)).success) return false;
  try {
    const rootInfo = lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  await rm(path, { recursive: true, force: true, maxRetries: 2 });
  return true;
}

/**
 * The admin dir git created for the lane at `path` (MC3 I3): named by the `.git` file git just wrote, then checked from
 * the other side. It must be a direct child of `<common>/worktrees` and its `gitdir` file must point back at this lane's
 * `.git`. Git adds a counter to the name when it is taken, so the name is never derived from the folder. Throws otherwise.
 */
export function readAdminDir(path: string, commonDir: string): string {
  const dotGit = join(path, ".git");
  if (!lstatSync(dotGit).isFile()) throw new Error("lane .git is not a file");
  const named = /^gitdir: (\/[^\n]+)\n?$/.exec(readFileSync(dotGit, "utf8"));
  const admin = named?.[1];
  if (admin === undefined || dirname(admin) !== join(commonDir, WORKTREES_DIR) || !isLaneGitDir(admin))
    throw new Error("lane admin dir is not under the repository");
  if (readFileSync(join(admin, "gitdir"), "utf8").trim() !== dotGit)
    throw new Error("lane admin dir belongs to another worktree");
  return admin;
}
