import type { AutomationSettings } from "@pap/contracts";
import { randomUUID } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createHealthEvents, type HealthEvents } from "../health/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { createAdmission } from "./admit.ts";
import { createKeptKeyOf } from "./kept-folder.ts";
import { createKeptHeld } from "./kept-wait.ts";
import { createAgentTasks } from "./agent-tasks.ts";
import { createAgentBudget } from "./agent-budget.ts";
import { type BootReport, recoverTasks } from "./boot.ts";
import { createAutomationEvents } from "./events.ts";
import type { ImageWait } from "./image-wait.ts";
import { createFire } from "./fire.ts";
import { createGates } from "./gates.ts";
import { createPutOffs, waitingOf } from "./put-off.ts";
import { createRunLimits } from "./limits.ts";
import { createAgentStart, createAgentTaskLink } from "./runner-agent.ts";
import { createThreadStart } from "./runner-thread.ts";
import { createLaunch } from "./runner-launch.ts";
import { createRunner } from "./runner.ts";
import { createTaskViews } from "./task-view.ts";
import { createTaskStore, type TaskRow } from "./tasks.ts";
import { createTasksStream } from "./tasks-stream.ts";
import { type AgentBinding, type AgentPorts, createAgentBinding } from "./trigger-agent.ts";
import type { Triggers } from "./triggers.ts";

export interface EngineDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: Pick<Triggers, "get" | "resolveFolder" | "summaries" | "summary" | "kept">;
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
    | "admits"
    | "promptPending"
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
    | "openTaskOf"
    | "spentByTask"
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
  /** The agents' ports, bound late (M11); one is made when the caller has none. */
  readonly agents?: AgentBinding;
  /** Does the task's box build its image now (launch progress)? Absent: no task waits for a build. */
  readonly imageBuild?: ImageWait;
  /** The health events (Task 3): the runner's failures; one is made when the caller has none. */
  readonly health?: HealthEvents;
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
  const agents = deps.agents ?? createAgentBinding();
  const health = deps.health ?? createHealthEvents(logger);
  const putOff = createPutOffs((id) => {
    // A task that waits for something new (or no longer) is told to the board, state unchanged.
    const row = store.get(id);
    if (row?.state === "queued") runner.announce(id, row.state);
  });
  const views = createTaskViews({
    waiting: (taskId) => waitingOf(putOff.get(taskId)),
    sessions: deps.sessions,
    runs: deps.runs,
    policy: deps.policy,
    threadCost: (taskId) => agents.ports()?.spend.taskRuns(taskId).usd ?? 0,
  });
  const gates = createGates({
    clock,
    settings: deps.settings,
    runs: deps.runs,
    triggers: deps.triggers,
    store,
    agentBudget: createAgentBudget({ binding: agents, settings: deps.settings }),
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
    agentPaused(ownerId, agentId) {
      const agent = agents.ports()?.registry.get(ownerId, agentId);
      return agent !== undefined && agent !== null && (agent.paused || agent.quarantinedAt !== null);
    },
  });
  const launch = createLaunch({
    db,
    clock,
    store,
    marks: deps.triggerMarks,
    starting,
    putOff,
    announce: (id, previous) => runner.announce(id, previous),
    limits: { started: (task) => limits.started(task) },
    runs: deps.runs,
    sessions: deps.sessions,
    settle: (row, from, to, change) => runner.settle(row, from, to, change),
  });
  const thread = createThreadStart({
    clock,
    logger,
    binding: agents,
    store,
    sessions: deps.sessions,
    starting,
    putOff,
    settle: (row, from, to, change) => runner.settle(row, from, to, change),
    launch,
  });
  const agentStart = createAgentStart({
    db,
    clock,
    logger,
    binding: agents,
    store,
    views,
    policy: deps.policy,
    putOff,
    thread,
    kept: deps.triggers.kept,
  });
  const admission = createAdmission({
    held: createKeptHeld({ db, store, starting }),
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
    ...(deps.imageBuild ? { imageBuild: deps.imageBuild } : {}),
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
    agents: agentStart,
    thread,
    launch,
    health,
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
    views,
    store,
    admission,
    /** The health events the runner emits to (Task 3): the composition's, or this engine's own. */
    health,
    /** The agents' ports (M11): bound once by the composition. */
    agents,
    /** The task makers and counts of the delegation and reminder ops (M11R78, M11R80). */
    agentTasks: createAgentTasks({
      db,
      clock,
      logger,
      binding: agents,
      store,
      outbox: deps.outbox,
      events,
      views,
      gates,
      newId: deps.newId ?? randomUUID,
    }),
    /** Binds them, then settles the cards of thread tasks that ended while they were not there (the boot ran first). */
    bindAgents(ports: AgentPorts): void {
      agents.bind(ports);
      thread.settleCards();
      agentStart.replay();
    },
    /** The tasks whose start is in flight. */
    starting: (): string[] => [...starting.keys()],
    /** What an agent's delete asks of the tasks (carry 1). */
    taskLink: createAgentTaskLink({
      store,
      starting: () => [...starting.keys()],
      cancel: (ownerId, taskId) => runner.cancel(ownerId, taskId),
    }),
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
        health,
      }),
    /** The kept folder key of a task session at its relaunch (I2). */
    keptKeyOf: createKeptKeyOf(store, deps.triggers),
    stop(): void {
      deps.triggers.kept.stop();
      limits.stop();
      runner.stop();
      stream.stop();
    },
  };
}
export type Engine = ReturnType<typeof createTaskEngine>;
