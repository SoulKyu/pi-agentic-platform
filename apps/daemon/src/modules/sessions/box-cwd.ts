import { PapError } from "@pap/contracts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";

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

/** `boxCwdOf` for a session or a task that is about to be made: a box being deleted takes no new work (`not_found`, before any row). */
export function newBoxCwdOf(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  cwd: string,
): { readonly projectId: string; readonly cwd: string } | null {
  const found = boxCwdOf(source, ownerId, cwd);
  if (found && source?.box(found.projectId)?.deleting !== false) throw new PapError("not_found");
  return found;
}
