import type { AutomationSettings } from "@pap/contracts";
import { randomUUID } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { createAdmission } from "./admit.ts";
import { type BootReport, recoverTasks } from "./boot.ts";
import { createAutomationEvents } from "./events.ts";
import { createFire } from "./fire.ts";
import { createGates } from "./gates.ts";
import { createRunLimits } from "./limits.ts";
import { createRunner } from "./runner.ts";
import { createTaskViews } from "./task-view.ts";
import { createTaskStore, type TaskRow } from "./tasks.ts";
import { createTasksStream } from "./tasks-stream.ts";
import type { Triggers } from "./triggers.ts";

export interface EngineDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: Pick<Triggers, "get" | "resolveFolder" | "summaries" | "summary">;
  /** The trigger's own `last_fire_at` and `last_start_at`: written by the triggers store, called here. */
  readonly triggerMarks: {
    fired(ownerId: string, triggerId: string, at: number): void;
    started(ownerId: string, triggerId: string, at: number): void;
  };
  readonly sessions: Pick<
    SessionsAutomationPort,
    | "createTaskSession"
    | "prompt"
    | "abort"
    | "releaseIdle"
    | "archive"
    | "state"
    | "answerUnattended"
    | "onAttention"
  >;
  readonly runs: Pick<
    RunsPort,
    | "onRunStart"
    | "onRunEnd"
    | "expectOrigin"
    | "clearExpected"
    | "sessionCost"
    | "limitResetAt"
    | "spentToday"
    | "spentTodayOf"
    | "markEnding"
    | "onLiveCost"
    | "onResumeSkipped"
  >;
  readonly policy: Pick<PolicyPort, "endTaskPolicy" | "sessionPolicy" | "unattendedSessions">;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly outbox: Pick<
    Outbox,
    "register" | "poke" | "cancel" | "view" | "failures" | "dismiss" | "onFailed" | "db"
  >;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly readOnly: boolean;
  readonly newId?: () => string;
  /** The receipts of a task's pending resumes, which Cancel retires with the task (Task 17); none until then. */
  readonly resumeKeys?: (task: TaskRow) => readonly string[];
  /** A resume's continuation is on its way into the session (Task 17). */
  readonly resumeSending?: (sessionId: string) => boolean;
  /** Tests only (`PAP_TEST_OUTBOX_HOLD=cancel`, M10R80): Cancel stops right after its commit, before it aborts the session. */
  readonly holdCancel?: boolean;
}

/**
 * The runner core (Task 5a): the one fire path, the task state machine, admission and start, Cancel and Retry, the
 * boot recovery and the `tasks` stream, wired over the ports of the other modules. Read-only mode: nothing listens.
 */
export function createTaskEngine(deps: EngineDeps) {
  const { db, clock } = deps;
  const logger = deps.logger.child({ component: "runner" });
  const store = createTaskStore(db);
  const events = createAutomationEvents(logger);
  const starting = new Map<string, string>();
  const views = createTaskViews({
    sessions: deps.sessions,
    runs: deps.runs,
    policy: deps.policy,
  });
  const gates = createGates({
    clock,
    settings: deps.settings,
    runs: deps.runs,
    triggers: deps.triggers,
    store,
  });
  const fire = createFire({
    db,
    clock,
    logger,
    store,
    triggers: deps.triggers,
    marks: deps.triggerMarks,
    settings: deps.settings,
    gates,
    outbox: deps.outbox,
    events,
    views,
    newId: deps.newId ?? randomUUID,
  });
  const putOff = new Map<string, number>();
  const admission = createAdmission({
    store,
    settings: deps.settings,
    starting,
    putOff,
    now: () => clock.now(),
  });
  const limits = createRunLimits({
    clock,
    logger,
    store,
    runs: deps.runs,
    port: deps.sessions,
    gates,
    events,
    stop: (task, reason) => runner.stopRun(task, reason),
  });
  const runner = createRunner({
    gates,
    limits,
    db,
    clock,
    logger,
    store,
    events,
    views,
    fire,
    admission,
    putOff,
    starting,
    triggers: deps.triggers,
    marks: deps.triggerMarks,
    sessions: deps.sessions,
    runs: deps.runs,
    policy: deps.policy,
    outbox: deps.outbox,
    resumeKeys: deps.resumeKeys ?? (() => []),
    resumeSending: deps.resumeSending ?? (() => false),
    holdCancel: deps.holdCancel,
  });
  const stream = createTasksStream({
    clock,
    logger,
    store,
    views,
    events,
    hub: deps.hub,
    outbox: deps.outbox,
    triggers: deps.triggers,
    runs: deps.runs,
    settings: deps.settings,
  });

  deps.outbox.register("task.start", (payload, context) => runner.handleStart(payload, context));
  if (!deps.readOnly) {
    runner.listen();
    limits.listen();
  }

  return {
    fire,
    gates,
    runner,
    stream,
    events,
    store,
    admission,
    /** The tasks whose start is in flight. */
    starting: (): string[] => [...starting.keys()],
    counts: stream.counts,
    /** The tasks' part of the boot (M10R42): before the server listens, after the outbox and the runs recovered. */
    recover: (): BootReport =>
      recoverTasks({
        db,
        clock,
        logger,
        store,
        runner,
        policy: deps.policy,
        sessions: deps.sessions,
        outbox: deps.outbox,
        readOnly: deps.readOnly,
      }),
    stop(): void {
      limits.stop();
      runner.stop();
      stream.stop();
    },
  };
}
export type Engine = ReturnType<typeof createTaskEngine>;
