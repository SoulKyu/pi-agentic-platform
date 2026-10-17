import { openScratch, removeScratch, scratchPathOf, sweepScratch, type WalkIssue } from "./homes.ts";

/** What the automation module may do with an isolated task's scratch folder (M11R180); every call names an agent of the owner. */
export interface ScratchPort {
  /** Made new, or the one the task made before (`reused`). */
  openScratch(
    ownerId: string,
    agentId: string,
    taskId: string,
  ): { readonly path: string; readonly reused: boolean };
  scratchPathOf(ownerId: string, agentId: string, taskId: string): string;
  /** Its task session was deleted: the folder goes, a link inside never followed. */
  removeScratch(ownerId: string, agentId: string, taskId: string, issue?: WalkIssue): void;
  /** Removes the folders `keep` does not name, at most `limit` (the housekeeping pass); links are unlinked, never followed. */
  sweepScratch(
    keep: (agentId: string, taskId: string, path: string) => boolean,
    limit: number,
    onError?: (info: { code: string; name: string }) => void,
  ): number;
}

/** `owned` throws `not_found` for an agent that is not the owner's. */
export function createScratchPort(
  papHome: string,
  owned: (ownerId: string, agentId: string) => void,
): ScratchPort {
  return {
    openScratch(ownerId, agentId, taskId) {
      owned(ownerId, agentId);
      return openScratch(papHome, agentId, taskId);
    },
    scratchPathOf(ownerId, agentId, taskId) {
      owned(ownerId, agentId);
      return scratchPathOf(papHome, agentId, taskId);
    },
    sweepScratch: (keep, limit, onError) => sweepScratch(papHome, keep, limit, onError),
    removeScratch(ownerId, agentId, taskId, issue) {
      owned(ownerId, agentId);
      removeScratch(papHome, agentId, taskId, issue);
    },
  };
}
