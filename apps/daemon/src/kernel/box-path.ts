import { PapError } from "@pap/contracts";
import type { ProjectBoxSource } from "./boxes.ts";
import { canonical } from "./fs/boundary.ts";

/** The auth module's answer to "is this user a member?" (M14). Required wherever a path or a process is routed. */
export type IsMember = (userId: string) => boolean;

export interface BoxMatch {
  readonly projectId: string;
  readonly root: string;
}

/**
 * The box project a path of the owner's belongs to, or null (a host path, or no box source bound). A path that is not
 * lexically clean is never a box path, whatever the source says: the host boundary refuses it.
 */
export function boxOfPath(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  path: string,
): BoxMatch | null {
  return canonical(path) ? (source?.byPath(ownerId, path) ?? null) : null;
}

/**
 * The host gate (M14): for a member, a path that is not at or under one of their box roots is `forbidden`. The check is
 * lexical (`byPath`), so a refused path never reaches a stat or a realpath of the host. Returns the matched box, which the
 * caller routes with: a box removed between the gate and the use is refused again, never resolved on the host. Returns null
 * for a non-member, who follows the rules of their own paths.
 */
export function assertBoxOnly(
  deps: { readonly isMember: IsMember },
  source: ProjectBoxSource | undefined,
  ownerId: string,
  path: string,
): BoxMatch | null {
  if (!deps.isMember(ownerId)) return null;
  const found = boxOfPath(source, ownerId, path);
  if (found === null) throw new PapError("forbidden");
  return found;
}

/** `assertBoxOnly`, else the plain `boxOfPath`: the box a path routes to, which for a member is never null. */
export function routeBoxPath(
  deps: { readonly isMember: IsMember },
  source: ProjectBoxSource | undefined,
  ownerId: string,
  path: string,
): BoxMatch | null {
  return assertBoxOnly(deps, source, ownerId, path) ?? boxOfPath(source, ownerId, path);
}
