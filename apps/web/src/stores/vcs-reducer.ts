import { VcsStreamEvent, type VcsStatus } from "@pap/contracts";

export interface VcsView {
  /** By root, least recently updated first. `null`: the daemon says the root is not a repository. */
  readonly statuses: ReadonlyMap<string, VcsStatus | null>;
  /** Events this build could not read (a newer kind, a shape the schema refuses): skipped, never fatal. */
  readonly skipped: number;
}

export const EMPTY_VCS: VcsView = { statuses: new Map(), skipped: 0 };

/** Roots held at once: a few projects plus the folders a user browsed; older ones are asked for again on return. */
export const MAX_VCS_ROOTS = 32;

export function reduceVcs(view: VcsView, root: string, event: unknown): VcsView {
  const parsed = VcsStreamEvent.safeParse(event);
  if (!parsed.success) return { ...view, skipped: view.skipped + 1 };
  const statuses = new Map(view.statuses);
  // Delete first so that the root moves to the end of the insertion order: the front is the stalest.
  statuses.delete(root);
  statuses.set(root, parsed.data.status);
  for (const stale of statuses.keys()) {
    if (statuses.size <= MAX_VCS_ROOTS) break;
    statuses.delete(stale);
  }
  return { statuses, skipped: view.skipped };
}
