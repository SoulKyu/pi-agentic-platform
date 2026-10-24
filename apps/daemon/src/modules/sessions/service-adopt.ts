import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { PapError, type ShellSession } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-session.ts";
import type { ProjectLink } from "./project-link.ts";
import { tailHoldsToolResults } from "./outside-tail.ts";
import { createOutsideWrites } from "./outside-writes.ts";
import { createScanPort } from "./scan-port.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow, SessionsStore } from "./store.ts";

/** What adopting Pi files needs of the service: its store, its live workers and its shell plumbing (Task 14). */
export interface AdoptionContext {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly agentDir: string;
  /** Pap's mirrors of VM session files live under it (agents', boxes'). */
  readonly papHome: string;
  newId(): string;
  ownerId(): string | null;
  onAdopted?(sessionId: string): void;
  onOutsideToolResults(sessionId: string): void;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly link: ProjectLink;
  readonly publisher: ShellPublisher;
  activity(sessionId: string): void;
  summary(sessionId: string, ownerId: string): ShellSession | null;
}

export function createAdoption(ctx: AdoptionContext) {
  // Pap's own last write and the file's size then, kept in the table across a restart (MC19 a). A failure is logged: the
  // in-memory memory still serves this run, and a session left without a stamp is not guessed at (migration note).
  const stampPapWrite = (sessionId: string, at: number): void => {
    if (ctx.store.readOnly) return;
    try {
      const file = ctx.store.get(sessionId)?.piPath ?? null;
      ctx.store.setPapWrote(sessionId, at, file === null ? null : statSync(file).size);
    } catch (error) {
      ctx.logger.warn("pap_wrote_not_stored", { sessionId, err: error });
    }
  };
  const outside = createOutsideWrites(ctx.clock, stampPapWrite);
  const scanPort = createScanPort({
    store: ctx.store,
    agentDir: ctx.agentDir,
    mirrorRoots: [join(ctx.papHome, "agents", ".mirrors"), join(ctx.papHome, "boxes", ".mirrors")],
    clock: ctx.clock,
    logger: ctx.logger,
    newId: ctx.newId,
    ownerId: ctx.ownerId,
    livePiSession: (piId) => {
      for (const [id, session] of ctx.live)
        if (session.piSessionId() === piId) return ctx.store.get(id) ?? null;
      return null;
    },
    assignProject: ctx.link.assign,
    publisher: ctx.publisher,
    activity: ctx.activity,
    summary: ctx.summary,
    onAdopted: ctx.onAdopted ?? (() => {}),
    onOutsideToolResults: ctx.onOutsideToolResults,
    startedAt: outside.startedAt,
    isLive: (id) => ctx.live.has(id) || outside.isStarting(id),
    workerEndedAt: outside.workerEndedAt,
    liveIdleSince: (id) => ctx.live.get(id)?.quietSince() ?? null,
  });
  /** A draft's worker reported its Pi id at `ready`: kept in the table, so a restart forgets nothing (RT-01). */
  const onDraftReady = (sessionId: string, piSessionId: string): void => {
    try {
      ctx.store.marks.setPendingPiId(sessionId, piSessionId);
    } catch (error) {
      ctx.logger.warn("session_pending_id_not_stored", { sessionId, err: error });
    }
  };
  /**
   * Before a worker opens a session's Pi file (MC19 c, MC21): an owed taint is made now. Then, when the file changed
   * after the later of the row's `updated_at` (the scanner decided up to there; a Clear leaves it alone) and pap's last
   * write, the session is tainted: at once when no stamp says where pap's bytes end, otherwise when tool results (or
   * anything unreadable) lie past the stamped size. An mtime equal to the mark counts as unchanged (granularity
   * residual). A taint that cannot be stored refuses the start.
   */
  const beforeStart = (row: SessionRow): void => {
    if (ctx.store.readOnly || row.piPath === null) return;
    try {
      scanPort.settleOwed(row.id);
      const wrote = ctx.store.papWrote(row.id);
      const mark = Math.max(ctx.store.get(row.id)?.updatedAt ?? row.updatedAt, wrote.at ?? -1);
      let changed = true;
      try {
        const stat = lstatSync(row.piPath);
        // A link or a non-file is never "unchanged": its own mtime says nothing about what it points at.
        changed = !stat.isFile() || Math.trunc(stat.mtimeMs) > mark;
      } catch {
        // Cannot look: not known to be unchanged, so the checks below decide (an unopenable file taints).
      }
      if (!changed) return;
      if (wrote.size === null || tailHoldsToolResults(row.piPath, wrote.size))
        ctx.onOutsideToolResults(row.id);
    } catch (error) {
      ctx.logger.error("session_start_refused_taint", { sessionId: row.id, err: error });
      throw new PapError("internal");
    }
  };
  return {
    scanPort,
    /** Whether the session's Pi file changed outside pap within the last 2 minutes (owner Q13). */
    outsideWrite: (sessionId: string): boolean => outside.recent(scanPort.outsideWriteAt(sessionId)),
    /** The worker's side of the table and of the outside-write memory, for `LaunchContext`. */
    launchHooks: {
      onDraftReady,
      onWorkerEnd: outside.workerEnded,
      onStarting: outside.starting,
      onStarted: outside.started,
      beforeStart,
    },
    /** A file pap's own writer made for this session: the same as a worker having ended on it. */
    fileMade: outside.workerEnded,
  };
}
