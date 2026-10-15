import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { PapError } from "@pap/contracts";
import { within } from "../../kernel/fs/boundary.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/** What the rest of the daemon asks of lanes (M9R35): synchronous, on real paths, answered from memory. */
export interface LanePaths {
  /** The lane's project root for its worktree or a folder inside it; null for any other folder. */
  scopeOf(cwd: string): string | null;
  /** The owner's non-archived worktrees: file roots next to the owner's project roots. */
  roots(ownerId: string): readonly string[];
  laneOf(cwd: string): LaneRow | null;
  /** `archiving` or `archived` for those lanes' folders (also a folder that is gone), else null. */
  closed(cwd: string): "archiving" | "archived" | null;
  /**
   * A session of `ownerId` whose folder is inside another owner's lane is refused with `forbidden`: the folder alone
   * decides which lane a session belongs to, and the edit policy then trusts it (Task 8's carry).
   */
  assertOwnLane(ownerId: string, cwd: string): void;
}

export interface LanePathsIndex extends LanePaths {
  /** Reads the store again: at boot, and after every create, failure and archive. */
  rebuild(): void;
}

/** The real path of `path`; a part that does not exist (a removed worktree) keeps its name under its real parent. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(realish(parent), basename(path));
  }
}

export function createLanePaths(store: Pick<LanesStore, "tracked">): LanePathsIndex {
  let lanes: LaneRow[] = [];
  let roots = new Map<string, string[]>();

  const laneOf = (cwd: string): LaneRow | null => {
    if (lanes.length === 0 || !cwd.startsWith("/")) return null;
    const real = realish(cwd);
    return lanes.find((lane) => within(lane.worktree, real)) ?? null;
  };

  return {
    rebuild() {
      // An archived lane stays for the life of the daemon (its folder is `closed`), so it keeps no description.
      lanes = store
        .tracked()
        .map((lane) => (lane.state === "archived" ? { ...lane, description: "" } : lane));
      roots = new Map();
      for (const lane of lanes) {
        if (lane.state === "archived") continue;
        roots.set(lane.ownerId, [...(roots.get(lane.ownerId) ?? []), lane.worktree]);
      }
    },
    laneOf,
    scopeOf: (cwd) => laneOf(cwd)?.projectRoot ?? null,
    roots: (ownerId) => roots.get(ownerId) ?? [],
    closed(cwd) {
      const state = laneOf(cwd)?.state;
      return state === "archiving" || state === "archived" ? state : null;
    },
    assertOwnLane(ownerId, cwd) {
      const lane = laneOf(cwd);
      if (lane && lane.ownerId !== ownerId) throw new PapError("forbidden");
    },
  };
}
