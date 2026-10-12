import type { ShellSession } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-session.ts";
import type { ProjectLink } from "./project-link.ts";
import { createOutsideWrites } from "./outside-writes.ts";
import { createScanPort } from "./scan-port.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionsStore } from "./store.ts";

/** What adopting Pi files needs of the service: its store, its live workers and its shell plumbing (Task 14). */
export interface AdoptionContext {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly agentDir: string;
  newId(): string;
  ownerId(): string | null;
  onAdopted?(sessionId: string): void;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly link: ProjectLink;
  readonly publisher: ShellPublisher;
  activity(sessionId: string): void;
  summary(sessionId: string, ownerId: string): ShellSession | null;
}

export function createAdoption(ctx: AdoptionContext) {
  const outside = createOutsideWrites(ctx.clock);
  const scanPort = createScanPort({
    store: ctx.store,
    agentDir: ctx.agentDir,
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
    startedAt: outside.startedAt,
    isLive: (id) => ctx.live.has(id) || outside.isStarting(id),
    workerEndedAt: outside.workerEndedAt,
  });
  /** A draft's worker reported its Pi id at `ready`: kept in the table, so a restart forgets nothing (RT-01). */
  const onDraftReady = (sessionId: string, piSessionId: string): void => {
    try {
      ctx.store.marks.setPendingPiId(sessionId, piSessionId);
    } catch (error) {
      ctx.logger.warn("session_pending_id_not_stored", { sessionId, err: error });
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
    },
    /** A file pap's own writer made for this session: the same as a worker having ended on it. */
    fileMade: outside.workerEnded,
  };
}
