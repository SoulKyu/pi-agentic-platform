import { PapError } from "@pap/contracts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import { type IsMember, routeBoxPath } from "../../kernel/box-path.ts";

/**
 * A folder of a box project: its root or a path below it by whole segments (the source's own lexical rule). The cwd keeps
 * the spelling it was given: a box path is not on this machine, so it is never resolved with `realpath`. Anything else
 * (a look-alike, another owner's box, no source yet) is null and follows the host path rules.
 */
export function boxCwdOf(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  cwd: string,
): { readonly projectId: string; readonly cwd: string } | null {
  const found = source?.byPath(ownerId, cwd);
  return found ? { projectId: found.projectId, cwd } : null;
}

/**
 * `boxCwdOf` for a place that starts host work (a session, a task, a trigger's folder, a terminal): a member's folder that is
 * not in one of their boxes is `forbidden` here, before any host path rule runs (M14).
 */
export function gatedBoxCwdOf(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  cwd: string,
  isMember: IsMember,
): { readonly projectId: string; readonly cwd: string } | null {
  const found = routeBoxPath({ isMember }, source, ownerId, cwd);
  return found ? { projectId: found.projectId, cwd } : null;
}

/** `gatedBoxCwdOf` for a session or a task that is about to be made: a box being deleted takes no new work (`not_found`, before any row). */
export function newBoxCwdOf(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  cwd: string,
  isMember: IsMember,
): { readonly projectId: string; readonly cwd: string } | null {
  const found = gatedBoxCwdOf(source, ownerId, cwd, isMember);
  if (found && source?.box(found.projectId)?.deleting !== false) throw new PapError("not_found");
  return found;
}
