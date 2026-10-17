import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createStagedCache, isInstalled, listStaged, type StagedCache } from "./mem0-files.ts";

/** The review queue is read this often (M11R148). */
export const REVIEW_INTERVAL_MS = 30_000;
/** Facts one quarantine looks through: far past the queue's 200, so a flooded queue cannot hide a fact. */
const QUARANTINE_SCAN = 10_000;
export const REVIEW_KIND = "memory_review";

export interface ReviewDeps {
  readonly dir: string;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn">;
  /** The database is one a newer pap wrote: no Inbox item is written. */
  readonly readOnly: boolean;
  /** The owner of an agent; null for one that is gone (its fact is not raised). */
  ownerOf(agentId: string): string | null;
  /** The tick's memory of the fact files it read; one is made when none is given. */
  readonly cache?: StagedCache;
  readonly inbox: {
    upsertAgentItem(input: {
      readonly ownerId: string;
      readonly kind: string;
      readonly agentId: string;
      readonly refId: string;
      readonly detail: null;
      readonly toHandle: boolean;
    }): boolean;
    resolveRef(
      ownerId: string,
      kind: string,
      refId: string,
      resolution: "answered" | "timed_out" | null,
    ): boolean;
    /** The open items of a kind: what a previous run raised and nobody closed. */
    openRefs(kind: string): ReadonlyArray<{ ownerId: string; agentId: string; refId: string }>;
  };
}

interface Open {
  readonly ownerId: string;
  readonly agentId: string;
}

/**
 * The approval queue (M11R148): facts that untrusted runs staged become `memory_review` Inbox items (`ref_id` = the fact
 * id); an item closes when its fact got a decision or vanished. Also the quarantine step that moves an agent's facts aside.
 */
export function createReview(deps: ReviewDeps) {
  const open = new Map<string, Open>();
  const cache = deps.cache ?? createStagedCache();
  let timer: TimerHandle | null = null;
  let running = false;
  let lastSkipped = 0;
  let stopped = true;

  /** Agents whose staged facts were skipped as orphans, logged once each (bounded). */
  const orphans = new Set<string>();
  const accept = (agent: string): boolean => {
    if (deps.ownerOf(agent) !== null) return true;
    if (!orphans.has(agent) && orphans.size < 1000) {
      orphans.add(agent);
      deps.logger.warn("memory_staged_orphan", { agentId: agent });
    }
    return false;
  };

  function tick(): void {
    if (deps.readOnly) return;
    const skipped = { count: 0 };
    const facts = listStaged(deps.dir, { accept, skipped, cache, now: deps.clock.now() });
    if (skipped.count > 0 && skipped.count !== lastSkipped) {
      deps.logger.warn("memory_staged_skipped", { count: skipped.count });
    }
    lastSkipped = skipped.count;
    // Only a fresh claim (pi-mem0 is applying it, under 10 minutes) settles a fact. A decision nobody claimed is still
    // pending: the owner is asked again once the claim went stale or never came.
    const pending = new Set<string>();
    const settled = new Set<string>();
    for (const fact of facts) {
      if (fact.applying) {
        settled.add(fact.id);
        continue;
      }
      const ownerId = deps.ownerOf(fact.agent);
      if (ownerId === null) continue;
      pending.add(fact.id);
      if (open.has(fact.id)) continue;
      // The fact text stays out of the Inbox (W5-R61): `memory.staged` shows it, fenced, to the browser only.
      const raised = deps.inbox.upsertAgentItem({
        ownerId,
        kind: REVIEW_KIND,
        agentId: fact.agent,
        refId: fact.id,
        detail: null,
        toHandle: true,
      });
      if (raised) open.set(fact.id, { ownerId, agentId: fact.agent });
    }
    for (const [factId, entry] of open) {
      if (pending.has(factId)) continue;
      deps.inbox.resolveRef(entry.ownerId, REVIEW_KIND, factId, settled.has(factId) ? "answered" : null);
      open.delete(factId);
    }
  }

  /** After a restart the Inbox still holds what was raised: those facts are not raised again (their unread state stays). */
  function load(): void {
    try {
      for (const item of deps.inbox.openRefs(REVIEW_KIND))
        open.set(item.refId, { ownerId: item.ownerId, agentId: item.agentId });
    } catch (error) {
      deps.logger.warn("memory_review_load_failed", { err: error });
    }
  }

  function guarded(): void {
    if (running) return;
    running = true;
    try {
      tick();
    } catch (error) {
      deps.logger.warn("memory_review_failed", { err: error });
    } finally {
      running = false;
    }
  }

  function arm(): void {
    timer = deps.clock.setTimeout(() => {
      timer = null;
      guarded();
      if (!stopped) arm();
    }, REVIEW_INTERVAL_MS);
  }

  return {
    tick,
    start(): void {
      if (!stopped) return;
      stopped = false;
      load();
      arm();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) deps.clock.clearTimeout(timer);
      timer = null;
    },

    /**
     * Quarantine's memory step (M11R148): the agent's facts and their decisions are renamed into
     * `staging/quarantine-<stamp>/` (0700), never rewritten. A fact pi-mem0 is applying (`.processing`) stays where it is
     * and the step reports `applying` once the rest is moved. Returns how many facts were moved.
     */
    moveStaged(ownerId: string, agentId: string): number {
      if (!isInstalled(deps.dir)) return 0;
      const facts = listStaged(deps.dir, {
        accept: (agent) => agent === agentId,
        limit: QUARANTINE_SCAN,
        now: deps.clock.now(),
      });
      if (facts.length === 0) return 0;
      const staging = join(deps.dir, "staging");
      const target = join(staging, `quarantine-${deps.clock.now()}`);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      let moved = 0;
      let applying = false;
      for (const fact of facts) {
        if (fact.applying) {
          applying = true;
          continue;
        }
        renameSync(join(staging, `${fact.id}.json`), join(target, `${fact.id}.json`));
        if (fact.decision !== null) moveDecision(staging, target, fact.id);
        deps.inbox.resolveRef(ownerId, REVIEW_KIND, fact.id, null);
        open.delete(fact.id);
        moved += 1;
      }
      if (applying) throw new Error("applying");
      return moved;
    },
  };
}

/** A decision pi-mem0 claimed in between (ENOENT) is not ours any more: the rest goes on. */
function moveDecision(staging: string, target: string, factId: string): void {
  try {
    renameSync(join(staging, `${factId}.decision.json`), join(target, `${factId}.decision.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
