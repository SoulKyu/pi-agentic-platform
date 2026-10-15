import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { pushLane } from "../../kernel/git/push-lane.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { LanesStore } from "./store.ts";

/** One function per key at a time, in order; a failure does not stop the next. */
export interface Mutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The per-lane mutex of the outward operations (M9R69): a push and a PR creation of one lane never overlap. It is not
 * the lane lock, because they never write the worktree: holding that lock for the 120 s of a push let a late "before"
 * capture tear a checkpoint.
 */
export function createMutex(): Mutex {
  const tails = new Map<string, Promise<void>>();
  return {
    run(key, fn) {
      const turn = (tails.get(key) ?? Promise.resolve()).then(fn);
      const tail = turn.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return turn;
    },
  };
}

export interface PushDeps {
  readonly store: Pick<LanesStore, "getOwned">;
  readonly git: GitRunner;
  /** The git dir pap stored for the lane (MC3 I3). */
  gitDirOf(worktree: string): string | undefined;
  /** `Config.testGitProtocols` includes `file`. */
  readonly allowFile: boolean;
  readonly audit: Pick<AuditPort, "append">;
  readonly mutex: Mutex;
  refreshFacts(laneId: string): Promise<void>;
  refreshRemote(laneId: string): Promise<void>;
  publish(laneId: string): void;
  readonly logger: Logger;
  readonly readOnly: boolean;
}

export interface Pusher {
  push(caller: Caller, params: ParamsOf<"lanes.push">): Promise<ResultOf<"lanes.push">>;
}

/** `lanes.push` (M9R69): the kernel's push sequence under the lane's mutex; success is an audit row, an external write by the owner. */
export function createPusher(deps: PushDeps): Pusher {
  return {
    async push(caller, params) {
      const lane = deps.store.getOwned(caller.userId, params.laneId);
      if (!lane) throw new PapError("not_found");
      if (deps.readOnly) throw new PapError("read_only");
      const gitDir = deps.gitDirOf(lane.worktree);
      if (lane.state !== "active" || gitDir === undefined) return { ok: false, reason: "failed" };
      return deps.mutex.run(lane.id, async () => {
        let outcome: Awaited<ReturnType<typeof pushLane>>;
        try {
          outcome = await pushLane(
            { git: deps.git, logger: deps.logger, allowFile: deps.allowFile },
            { root: lane.worktree, gitDir, branch: lane.branch },
          );
        } catch (error) {
          if (error instanceof PapError) throw error;
          if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
          deps.logger.warn("lane_push_failed", { laneId: lane.id, err: error });
          return { ok: false, reason: "failed" };
        }
        if (!outcome.ok) return outcome;
        deps.audit.append({
          ownerId: lane.ownerId,
          actor: "user",
          kind: "policy",
          reason: "lane_pushed",
          detail: { laneId: lane.id, host: outcome.target.host, path: outcome.target.path },
        });
        await Promise.all([deps.refreshFacts(lane.id), deps.refreshRemote(lane.id)]);
        deps.publish(lane.id);
        return { ok: true, remote: { host: outcome.target.host, path: outcome.target.path } };
      });
    },
  };
}
