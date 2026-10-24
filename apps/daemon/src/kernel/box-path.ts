import type { ProjectBoxSource } from "./boxes.ts";
import { canonical } from "./fs/boundary.ts";

/**
 * The box project a path of the owner's belongs to, or null (a host path, or no box source bound). A path that is not
 * lexically clean is never a box path, whatever the source says: the host boundary refuses it.
 */
export function boxOfPath(
  source: ProjectBoxSource | undefined,
  ownerId: string,
  path: string,
): { readonly projectId: string; readonly root: string } | null {
  return canonical(path) ? (source?.byPath(ownerId, path) ?? null) : null;
}
