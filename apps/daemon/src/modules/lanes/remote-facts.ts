import type { ForgeKind, LaneView } from "@pap/contracts";
import { forgeOf } from "../../kernel/forge/remote.ts";
import { type PushLane, type PushLaneDeps, readPushTarget } from "../../kernel/git/push-lane.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/** What a lane's view says about its remote (M9R70). */
export interface RemoteInfo {
  /** The forge identity: `remote.origin.url` as configured. */
  readonly remote: LaneView["remote"];
  /** Where the Push button would really send the branch; null when the push is refused. */
  readonly pushRemote: LaneView["pushRemote"];
  readonly forge: LaneView["forge"];
}

export const NO_REMOTE: RemoteInfo = { remote: null, pushRemote: null, forge: null };

/**
 * The one function behind the lane view's `remote`, `forge` and `pushRemote` and the preview's `remote` and `forge`
 * (M9R70): the kernel's push reads from this lane's own root and git dir, and `forgeOf` over the identity.
 */
export async function readRemoteInfo(
  deps: PushLaneDeps,
  lane: PushLane,
  forgeLine: ForgeKind | undefined,
): Promise<RemoteInfo> {
  const read = await readPushTarget(deps, lane);
  return {
    remote: read.origin,
    pushRemote: read.target.ok ? read.target.target : null,
    forge: read.origin === null ? null : forgeOf(read.origin.host, forgeLine),
  };
}

export interface RemoteFactsDeps extends PushLaneDeps {
  readonly store: Pick<LanesStore, "get">;
  /** The git dir pap stored for the lane (MC3 I3). */
  gitDirOf(worktree: string): string | undefined;
  /** The `forge:` line of the lane's project, or undefined. */
  forgeOverride(lane: Pick<LaneRow, "ownerId" | "projectRoot">): Promise<ForgeKind | undefined>;
  changed(laneId: string): void;
}

export interface RemoteFacts {
  /** What is known now; empty before the first read. */
  get(laneId: string): RemoteInfo;
  /** `get`, and one background read when nothing is known yet and the lane is active. */
  view(laneId: string): RemoteInfo;
  /** Reads again (after a push or a refresh); waits for it, never throws. */
  refresh(laneId: string): Promise<void>;
  forget(laneId: string): void;
  settled(): Promise<void>;
}

/** Background reads at once, as for the facts: a snapshot of many lanes must not fill the git runner's queue. */
const BACKGROUND_AT_ONCE = 2;

export function createRemoteFacts(deps: RemoteFactsDeps): RemoteFacts {
  const known = new Map<string, RemoteInfo>();
  const waiting: string[] = [];
  let background = 0;
  const running = new Map<string, { again: boolean; done: Promise<void> }>();

  async function once(laneId: string): Promise<void> {
    const row = deps.store.get(laneId);
    const gitDir = row === undefined ? undefined : deps.gitDirOf(row.worktree);
    if (!row || row.state !== "active" || gitDir === undefined) return;
    let next: RemoteInfo;
    try {
      next = await readRemoteInfo(deps, { root: row.worktree, gitDir }, await deps.forgeOverride(row));
    } catch (error) {
      // A timeout or a full git queue: the last answer stays, the next trigger reads again.
      deps.logger.warn("lane_remote_facts_failed", { laneId, err: error });
      if (!known.has(laneId)) known.set(laneId, NO_REMOTE);
      return;
    }
    if (deps.store.get(laneId)?.state === "archived") return;
    known.set(laneId, next);
    deps.changed(laneId);
  }

  function refresh(laneId: string): Promise<void> {
    const current = running.get(laneId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      for (;;) {
        entry.again = false;
        await once(laneId);
        // Nothing awaits between this check and the delete: a trigger either set `again` before, or starts a new run.
        if (!entry.again) return void running.delete(laneId);
      }
    })();
    running.set(laneId, entry);
    return entry.done;
  }

  function pump(): void {
    while (background < BACKGROUND_AT_ONCE) {
      const laneId = waiting.shift();
      if (laneId === undefined) return;
      background += 1;
      void refresh(laneId)
        .catch((error: unknown) => deps.logger.error("lane_remote_facts_refresh_failed", { err: error }))
        .finally(() => {
          background -= 1;
          pump();
        });
    }
  }

  return {
    get: (laneId) => known.get(laneId) ?? NO_REMOTE,
    view(laneId) {
      const facts = known.get(laneId);
      if (
        facts === undefined &&
        !running.has(laneId) &&
        !waiting.includes(laneId) &&
        deps.store.get(laneId)?.state === "active"
      ) {
        waiting.push(laneId);
        pump();
      }
      return facts ?? NO_REMOTE;
    },
    refresh,
    forget: (laneId) => void known.delete(laneId),
    async settled() {
      while (running.size > 0 || waiting.length > 0) {
        await Promise.allSettled([...running.values()].map((entry) => entry.done));
        await Promise.resolve();
      }
    },
  };
}
