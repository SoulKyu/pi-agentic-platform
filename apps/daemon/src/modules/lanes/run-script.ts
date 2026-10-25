import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import type { ScriptRunner } from "./scripts.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/**
 * Whether a session of the lane has read content from outside (M9R119). An unbound sessions or policy port cannot say, so
 * it answers tainted: a script is never run on a guess.
 */
export function taintedIn(
  sessions: () => Pick<SessionsLanePort, "sessionIdsIn"> | undefined,
  policy: () => Pick<PolicyPort, "sessionPolicy"> | undefined,
): (lane: Pick<LaneRow, "ownerId" | "worktree">) => boolean {
  return (lane) => {
    const port = sessions();
    const rules = policy();
    if (!port || !rules) return true;
    return port
      .sessionIdsIn(lane.ownerId, lane.worktree)
      .some((sessionId) => rules.sessionPolicy(lane.ownerId, sessionId).taint.tainted);
  };
}

export interface RunScriptDeps {
  readonly store: Pick<LanesStore, "getOwned">;
  readonly scripts: Pick<ScriptRunner, "run">;
  readonly tainted: (lane: LaneRow) => boolean;
  readonly readOnly: boolean;
  readonly isMember: (userId: string) => boolean;
  /** A script started: the lane's view (its setup or test state) goes out. */
  publish(laneId: string): void;
}

/** `lanes.runScript`: the one browser-only door to running a setup or test script of a lane (M9R119). */
export function createRunScript(deps: RunScriptDeps) {
  return async function runScript(
    caller: Caller,
    params: ParamsOf<"lanes.runScript">,
  ): Promise<ResultOf<"lanes.runScript">> {
    // The lane comes from the store, by id and owner: the runner never gets a lane the caller described.
    if (deps.isMember(caller.userId)) throw new PapError("forbidden"); // a script is a host process (M14)
    const lane = deps.store.getOwned(caller.userId, params.laneId);
    if (!lane) throw new PapError("not_found");
    if (deps.readOnly) throw new PapError("read_only");
    if (lane.state !== "active") return { ok: false, reason: "not_active" };
    if (params.confirmTainted !== true && deps.tainted(lane)) return { ok: false, reason: "tainted" };
    const ref = {
      id: lane.id,
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
    };
    const answer = await deps.scripts.run(ref, params.kind);
    deps.publish(lane.id);
    return answer;
  };
}
