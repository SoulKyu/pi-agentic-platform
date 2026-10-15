import {
  type Caller,
  LANE_LIMITS,
  type ForgeKind,
  PapError,
  type ParamsOf,
  type PrView,
  type ResultOf,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { ForgeOutcome, ForgeResult } from "../../kernel/forge/cli.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import type { RemoteRef } from "../../kernel/forge/remote.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { actorOf } from "./audit-rows.ts";
import type { LaneFacts } from "./facts.ts";
import type { Mutex } from "./push.ts";
import type { RemoteFacts } from "./remote-facts.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/** A cached pull request is shown for this long before the forge is asked again (M9R71). */
export const PR_CACHE_MS = 60_000;

type CreateResult = ResultOf<"lanes.prCreate">;
type CreateRefusal = Extract<CreateResult, { ok: false }>["reason"];
type PrError = NonNullable<PrView["error"]>;

/** `refs/heads/main` and `refs/remotes/origin/main` are `main`; a commit base has no branch, and the forge takes its default. */
export function baseBranchOf(baseRef: string): string | undefined {
  const match = /^refs\/(?:heads\/|remotes\/[^/]+\/)(.+)$/.exec(baseRef);
  return match?.[1];
}

/** A read that timed out or came back too large says nothing about the forge's state: it is `failed`, and safe to repeat. */
const readError = (outcome: ForgeOutcome): PrError =>
  outcome === "forge_missing" || outcome === "not_signed_in" || outcome === "not_found" ? outcome : "failed";
const refusalOf = (outcome: ForgeOutcome): CreateRefusal =>
  outcome === "forge_missing" || outcome === "not_signed_in" ? outcome : "failed";

export interface PrDeps {
  readonly store: Pick<LanesStore, "getOwned" | "setPr">;
  forgeFor(kind: ForgeKind): Forge | null;
  readonly facts: Pick<LaneFacts, "get" | "refresh">;
  readonly remote: Pick<RemoteFacts, "get" | "refresh">;
  readonly mutex: Mutex;
  /** A pull request made on the forge is an external write by the owner: a row, never the body (final review M13). */
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(laneId: string): void;
  readonly readOnly: boolean;
}

export interface Prs {
  prCreate(caller: Caller, params: ParamsOf<"lanes.prCreate">): Promise<CreateResult>;
  prRefresh(caller: Caller, params: ParamsOf<"lanes.prRefresh">): Promise<ResultOf<"lanes.prRefresh">>;
  /** What the lane view shows: the last state read, else the stored number and URL with an unknown state; null without a pull request. */
  viewFor(lane: Pick<LaneRow, "id" | "prNumber" | "prUrl">): PrView | null;
  forget(laneId: string): void;
}

interface Cached {
  /** The last pull request read; null when the forge said the branch has none. */
  readonly pr: PrView | null;
  /** Set only by a good read: an error is never cached, so the next call asks again. */
  readonly fresh: boolean;
  readonly at: number;
}

const unknownState = (number: number, url: string): PrView => ({
  number,
  url,
  state: null,
  draft: false,
  conflicts: null,
  checks: null,
  checkedAt: null,
  error: null,
});

/** A forge call that cannot even build its arguments (a refused repository or branch) is a plain `failed` result. */
async function guarded<T>(
  logger: Logger,
  op: string,
  call: () => Promise<ForgeResult<T>>,
): Promise<ForgeResult<T>> {
  try {
    return await call();
  } catch (error) {
    logger.warn("lane_forge_call_refused", { op, err: error });
    return { ok: false, outcome: "failed" };
  }
}

/** An empty body from the client means the lane's own description (M9R92); the contract's cap applies either way. */
const bodyOf = (lane: Pick<LaneRow, "description">, sent: string): string =>
  (sent.trim() === "" ? lane.description : sent).slice(0, LANE_LIMITS.prBody);

export function createPrs(deps: PrDeps): Prs {
  const cache = new Map<string, Cached>();
  /** Lanes whose pull-request creation timed out: the forge may have made it, so the next refresh looks (M9R70). */
  const unknown = new Set<string>();
  const inflight = new Map<string, Promise<PrView | null>>();

  const owned = (caller: Caller, laneId: string): LaneRow => {
    const lane = deps.store.getOwned(caller.userId, laneId);
    if (!lane) throw new PapError("not_found");
    return lane;
  };

  function keep(lane: LaneRow, pr: PrView): void {
    // A read-only daemon writes nothing: the pull request stays in memory (a refresh is a read, M9R71).
    if (!deps.readOnly && (lane.prNumber !== pr.number || lane.prUrl !== pr.url))
      deps.store.setPr(lane.id, pr.number, pr.url);
    cache.set(lane.id, { pr, fresh: true, at: deps.clock.now() });
    deps.publish(lane.id);
  }

  /** The forge and repository of the lane, from facts read now. */
  async function target(lane: LaneRow): Promise<{ forge: Forge; repo: RemoteRef } | "unsupported"> {
    await deps.remote.refresh(lane.id);
    const info = deps.remote.get(lane.id);
    const forge = info.forge === null ? null : deps.forgeFor(info.forge);
    return info.remote === null || forge === null ? "unsupported" : { forge, repo: info.remote };
  }

  async function create(
    lane: LaneRow,
    params: ParamsOf<"lanes.prCreate">,
    caller: Caller,
  ): Promise<CreateResult> {
    await deps.facts.refresh(lane.id);
    if (deps.facts.get(lane.id)?.unpushed == null) return { ok: false, reason: "not_pushed" };
    const where = await target(lane);
    if (where === "unsupported") return { ok: false, reason: "unsupported_remote" };
    const { forge, repo } = where;
    const found = await guarded(deps.logger, "find_pr", () => forge.findPr(repo, lane.branch));
    if (!found.ok) return { ok: false, reason: refusalOf(found.outcome) };
    let pr: PrView;
    if (found.value?.state === "open") pr = found.value;
    else {
      const base = baseBranchOf(lane.baseRef);
      const made = await guarded(deps.logger, "create_pr", () =>
        forge.createPr(repo, {
          head: lane.branch,
          ...(base === undefined ? {} : { base }),
          title: params.title,
          body: bodyOf(lane, params.body),
          draft: params.draft,
        }),
      );
      if (!made.ok) {
        // A creation that timed out may have happened: never `failed`, never a blind retry (R105).
        if (made.outcome === "timeout" || made.outcome === "too_large") {
          unknown.add(lane.id);
          throw new PapError("timeout");
        }
        return { ok: false, reason: refusalOf(made.outcome) };
      }
      pr = made.value;
      deps.audit.append({
        ownerId: lane.ownerId,
        ...actorOf(caller),
        kind: "policy",
        reason: "lane_pr_created",
        detail: { laneId: lane.id, host: repo.host, path: repo.path, number: pr.number, draft: params.draft },
      });
    }
    unknown.delete(lane.id);
    const viewed = await guarded(deps.logger, "view_pr", () => forge.viewPr(repo, pr.number));
    keep(lane, viewed.ok ? viewed.value : pr);
    return { ok: true, pr: viewed.ok ? viewed.value : pr };
  }

  /** Looks for the lane's pull request when none is stored; true when the lane may have one (pushed, or a creation timed out). */
  const mayHavePr = (lane: LaneRow): boolean =>
    unknown.has(lane.id) || (lane.state === "active" && deps.facts.get(lane.id)?.unpushed != null);

  async function read(lane: LaneRow): Promise<PrView | null> {
    const hit = cache.get(lane.id);
    if (hit?.fresh === true && deps.clock.now() - hit.at < PR_CACHE_MS) return hit.pr;
    const last = hit?.pr ?? (lane.prNumber === null ? null : unknownState(lane.prNumber, lane.prUrl ?? ""));
    if (lane.state === "archived" || (last === null && !mayHavePr(lane))) return last;
    const where = await target(lane);
    if (where === "unsupported") return last === null ? null : { ...last, error: "failed" };
    const { forge, repo } = where;
    if (last === null) {
      const found = await guarded(deps.logger, "find_pr", () => forge.findPr(repo, lane.branch));
      if (!found.ok) return null;
      unknown.delete(lane.id);
      if (found.value === null) cache.set(lane.id, { pr: null, fresh: true, at: deps.clock.now() });
      else keep(lane, found.value);
      return found.value;
    }
    const viewed = await guarded(deps.logger, "view_pr", () => forge.viewPr(repo, last.number));
    if (!viewed.ok) {
      const kept = { ...last, error: readError(viewed.outcome) };
      cache.set(lane.id, { pr: kept, fresh: false, at: deps.clock.now() });
      return kept;
    }
    keep(lane, viewed.value);
    return viewed.value;
  }

  return {
    async prCreate(caller, params) {
      const lane = owned(caller, params.laneId);
      if (deps.readOnly) throw new PapError("read_only");
      if (lane.state !== "active") return { ok: false, reason: "failed" };
      return deps.mutex.run(lane.id, () => create(lane, params, caller));
    },
    async prRefresh(caller, params) {
      const lane = owned(caller, params.laneId);
      const running = inflight.get(lane.id);
      if (running) return { pr: await running };
      const work = read(lane).finally(() => inflight.delete(lane.id));
      inflight.set(lane.id, work);
      return { pr: await work };
    },
    viewFor(lane) {
      const cached = cache.get(lane.id)?.pr;
      if (cached) return cached;
      return lane.prNumber === null ? null : unknownState(lane.prNumber, lane.prUrl ?? "");
    },
    forget: (laneId) => {
      cache.delete(laneId);
      unknown.delete(laneId);
    },
  };
}
