import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import type { AuditPort } from "../audit/index.ts";
import type { ArchiveParams } from "./archive.ts";
import { actorOf } from "./audit-rows.ts";
import type { LanesStore } from "./store.ts";

type Answer = ResultOf<"lanes.closeLosers">;

export interface CloseLosersDeps {
  readonly store: Pick<LanesStore, "fanouts" | "getOwned">;
  /** The one archive path (the lane lock, the busy refusals, the archive script and its taint question). */
  archive(caller: Caller, params: ArchiveParams): Promise<ResultOf<"lanes.archive">>;
  /** One row per close; each loser's own forced archive leaves its row through `archive`. */
  readonly audit: Pick<AuditPort, "append">;
  readonly readOnly: boolean;
}

/** `force` skips the dirty refusal; should git still answer dirty, the lane is left alone as busy. */
const reasonOf = (
  reason: Exclude<ResultOf<"lanes.archive">, { ok: true }>["reason"],
): Answer["refused"][number]["reason"] => (reason === "dirty" ? "busy" : reason);

/**
 * `lanes.closeLosers` (M9R86): every lane of the group but the winner goes through `archive` with `force`, so its
 * uncommitted work goes and its commits stay on its branch (`deleteBranch: false`). A lane archive refuses, or fails
 * with a typed error, is listed and left alone, taint included: `confirmTainted` is the owner's word and is passed only when given.
 */
export function createCloseLosers(deps: CloseLosersDeps) {
  /** One close per group at a time: the second sees what the first did (two winners must not both destroy the other). */
  const chains = new Map<string, Promise<unknown>>();

  async function run(caller: Caller, params: ParamsOf<"lanes.closeLosers">): Promise<Answer> {
    const fanout = deps.store.fanouts(caller.userId, [params.fanoutId])[0];
    if (!fanout) throw new PapError("not_found");
    if (deps.readOnly) throw new PapError("read_only");
    if (!fanout.laneIds.includes(params.winner)) throw new PapError("bad_request");
    // A winner an earlier close already archived is no winner.
    if (deps.store.getOwned(caller.userId, params.winner)?.state === "archived")
      throw new PapError("bad_request");
    const archived: string[] = [];
    const refused: Answer["refused"] = [];
    for (const laneId of fanout.laneIds) {
      if (laneId === params.winner) continue;
      try {
        const result = await deps.archive(caller, {
          laneId,
          force: true,
          deleteBranch: false,
          confirmTainted: params.confirmTainted === true,
        });
        if (result.ok) archived.push(laneId);
        else refused.push({ laneId, reason: reasonOf(result.reason) });
      } catch (error) {
        // A typed failure of one lane (capacity: sessions unbound or stopping, or the worktree removal failed) must not
        // hide the lanes already archived: it is listed as left alone, `busy`, to retry. Anything else is a bug.
        if (!(error instanceof PapError)) throw error;
        refused.push({ laneId, reason: "busy" });
      }
    }
    deps.audit.append({
      ownerId: caller.userId,
      ...actorOf(caller),
      kind: "policy",
      reason: "lane_losers_closed",
      detail: {
        fanoutId: params.fanoutId,
        winner: params.winner,
        archived: archived.length,
        refused: refused.length,
      },
    });
    return { archived, refused };
  }

  return function closeLosers(caller: Caller, params: ParamsOf<"lanes.closeLosers">): Promise<Answer> {
    // The owner's own group only, before it joins a chain: a stranger waits behind nobody and learns nothing.
    if (!deps.store.fanouts(caller.userId, [params.fanoutId])[0])
      return Promise.reject(new PapError("not_found"));
    const previous = chains.get(params.fanoutId) ?? Promise.resolve();
    const work = previous.then(
      () => run(caller, params),
      () => run(caller, params),
    );
    const tail = work.catch(() => undefined);
    chains.set(params.fanoutId, tail);
    void tail.then(() => {
      if (chains.get(params.fanoutId) === tail) chains.delete(params.fanoutId);
    });
    return work;
  };
}
