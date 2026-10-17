import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AutomationSettings, Caller } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../audit/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import type { BootReport } from "./boot.ts";
import { createBackoff } from "./backoff.ts";
import { createTaskEngine, type Engine } from "./engine.ts";
import type { AutomationEvents } from "./events.ts";
import { lookup } from "node:dns";
import type { Span } from "../../kernel/observability/tracer.ts";
import { fetchFeed, type FeedFetchResult } from "./feed-fetch.ts";
import { createFeedPoller } from "./feed-poll.ts";
import { createHookJournal } from "./hook-journal.ts";
import { createHookRate } from "./hook-rate.ts";
import { createDryRun } from "./dry-run.ts";
import { createJournal } from "./journal.ts";
import { createManual } from "./manual.ts";
import { createPrecheckStep, type PrecheckPort } from "./precheck-step.ts";
import { createHousekeeping } from "./housekeeping.ts";
import { mountHookRoute } from "./hooks-http.ts";
import { createReleaseTools } from "./release-tools.ts";
import { createAgentScratchDropper, createAgentScratchSweeper } from "./runner-agent.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createAgentLink } from "./agent-link.ts";
import { createThreadQueue } from "./thread-queue.ts";
import { type AutomationRpc, automationRpc, taskActions } from "./rpc.ts";
import { createTriggerStore } from "./store.ts";
import { type AgentPorts, createAgentBinding, createAgentTriggerLink } from "./trigger-agent.ts";
import { triggerSecretsDir } from "./trigger-secrets.ts";
import { createTriggers, type TriggerChanged, type Triggers } from "./triggers.ts";

export type { AgentBinding, AgentPorts } from "./trigger-agent.ts";
export { createTriggers } from "./triggers.ts";
export type { TriggerChanged } from "./triggers.ts";
export { createTaskEngine, type Engine } from "./engine.ts";
export { createReleaseTools } from "./release-tools.ts";
export { createDryRun } from "./dry-run.ts";
export { createJournal } from "./journal.ts";
export { createManual } from "./manual.ts";
export { createPrecheckPort, systemPrecheckDeps } from "./precheck-port.ts";
export { createPrecheckStep, type PrecheckPort } from "./precheck-step.ts";
export { createFeedPoller } from "./feed-poll.ts";
export type { FeedFetchResult } from "./feed-fetch.ts";
export type { Operations } from "./rpc.ts";
export { createTriggerStore } from "./store.ts";
export type { AutomationRpc } from "./rpc.ts";
export type { BootReport } from "./boot.ts";
export type { FireInput, FireResult } from "./fire.ts";
export { type AutomationEvent, type AutomationEvents, createAutomationEvents } from "./events.ts";
export { automationCollector } from "./metrics.ts";

export const AUTOMATION_MIGRATIONS: MigrationSource = {
  module: "automation",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface AutomationDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: Pick<AuditPort, "append">;
  readonly projects: Pick<ProjectsPort, "ensure">;
  readonly policy: Pick<
    PolicyPort,
    "scopeOf" | "endTaskPolicy" | "clearTaskPolicy" | "sessionPolicy" | "unattendedSessions"
  >;
  readonly config: Pick<Config, "home" | "piAgentDir" | "publicOrigin" | "testOutboxHold">;
  /** The only way the runner reaches a session (M10R32). */
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
    | "deleteTaskSession"
    | "lastActivityAt"
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
    | "onResumeSkipped"
  >;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly outbox: Pick<
    Outbox,
    "register" | "poke" | "cancel" | "view" | "failures" | "dismiss" | "onFailed" | "db" | "purge"
  >;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  requireStepUp(caller: Caller, now: number): void;
  /** The Inbox's hourly retention, called by the housekeeping pass; none until the Inbox is built (M10R49). */
  readonly inboxRetention?: () => void;
  /** The outbox receipts of a task's pending resumes, which Cancel retires with the task (Task 17). */
  readonly resume?: {
    keysOf(sessionId: string): readonly string[];
    sending(sessionId: string): boolean;
  };
  /** A database written by a newer pap: the module arms nothing (M10R150). */
  readonly readOnly: boolean;
  /** Runs a trigger's precheck (Task 9); none: a scheduled fire, a manual fire and a dry-run then skip the step. */
  readonly precheck?: PrecheckPort;
  /** The `feed.fetch` span (closed values only); none: no span is written. */
  readonly feedSpan?: () => Span;
  /** Tests only: replaces the network fetch of a feed. Production leaves it out and gets the guarded fetch. */
  readonly feedFetch?: (url: string, signal: AbortSignal) => Promise<FeedFetchResult>;
}

export interface AutomationModule {
  readonly rpc: AutomationRpc;
  /** What the runner, the scheduler and the hook route read; they never write a trigger. */
  readonly triggers: Pick<Triggers, "get" | "getAt" | "listEnabled">;
  /** The one fire path (M10R34); the scheduler, the hook route, the feed poller and the manual fire call it. */
  readonly fire: Engine["fire"];
  /** What the runner says about tasks and their questions; the Inbox listens (M10R46). */
  readonly events: AutomationEvents;
  /** Who a task belongs to and which trigger it came from; null once its row is gone. */
  taskInfo(taskId: string): {
    ownerId: string;
    triggerName: string;
    sessionId: string | null;
    agentId: string | null;
  } | null;
  /** The task of a session and whether its trigger is over its daily budget (M10R66): the resume planner reads it. */
  taskOf(ownerId: string, sessionId: string): { taskId: string; overBudget: boolean } | null;
  /** What the agents registry asks of the triggers and tasks of an agent (M11, carry 1; quarantine, M11R115); bound by `agents.setLinks`. */
  readonly agentLink: ReturnType<typeof createAgentLink>;
  /** The task makers of `agent.delegate` and `agent.remind` and the counts of their caps (M11R78, M11R80). */
  readonly agentTasks: Engine["agentTasks"];
  /** The agents' registry, sessions and cards (M11): bound once by `composeM11`, before the server listens. */
  bindAgents(ports: AgentPorts): void;
  /** The tasks' part of the boot (M10R42); `composeAutomation` calls it once, before the server listens. */
  recover(): BootReport;
  /** `POST /hooks/<id>` (Task 7a): outside the Origin check and the cookie, before the static fallback. */
  mountHooks(app: Hono): void;
  /** After `startServer`: arms the module's timers (the hourly housekeeping, the scheduler). */
  start(): void;
  /** Stops hearing the runs and cancels the module's timers; running prechecks are aborted here (fetches too, later). */
  stop(): Promise<void>;
}

export function createAutomationModule(deps: AutomationDeps): AutomationModule {
  const logger = deps.logger.child({ module: "automation" });
  const triggerStore = createTriggerStore(deps.db);
  // The engine needs the triggers and the triggers tell the engine's stream: bound late.
  const late: { engine?: Engine; scheduler?: Scheduler } = {};
  const backoff = createBackoff(deps.clock);
  const rate = createHookRate(deps.clock);
  const agents = createAgentBinding();
  const triggerChanged = (change: TriggerChanged): void => {
    if (change.removed) {
      backoff.forget(change.triggerId);
      rate.forget(change.triggerId);
    }
    late.engine?.stream.triggerChanged(change);
    late.scheduler?.refresh();
  };
  const triggers = createTriggers({
    agents,
    db: deps.db,
    clock: deps.clock,
    logger,
    audit: deps.audit,
    projects: deps.projects,
    scopeOf: (cwd) => deps.policy.scopeOf(cwd),
    config: deps.config,
    requireStepUp: deps.requireStepUp,
    onChange: triggerChanged,
  });
  const built = createTaskEngine({
    agents,
    db: deps.db,
    clock: deps.clock,
    logger,
    triggers,
    triggerMarks: {
      fired: (ownerId, id, at) => void triggerStore.markFired(ownerId, id, at),
      started: (ownerId, id, at) => void triggerStore.markStarted(ownerId, id, at),
    },
    sessions: deps.sessions,
    runs: deps.runs,
    policy: deps.policy,
    settings: deps.settings,
    outbox: deps.outbox,
    hub: deps.hub,
    readOnly: deps.readOnly,
    resumeKeys: (task) => (task.session_id === null ? [] : (deps.resume?.keysOf(task.session_id) ?? [])),
    resumeSending: (sessionId) => deps.resume?.sending(sessionId) ?? false,
    holdCancel: deps.config.testOutboxHold === "cancel",
  });
  late.engine = built;
  const precheckStep = createPrecheckStep({
    db: deps.db,
    clock: deps.clock,
    logger,
    settings: deps.settings,
    gates: built.gates,
    triggers,
    precheck: deps.precheck,
    agents,
  });
  const feeds = createFeedPoller({
    db: deps.db,
    clock: deps.clock,
    logger,
    triggers,
    settings: deps.settings,
    gates: built.gates,
    fire: built.fire,
    fetch:
      deps.feedFetch ?? ((url, signal) => fetchFeed(url, { resolve: lookup, clock: deps.clock, signal })),
    precheck: precheckStep,
    span: deps.feedSpan,
  });
  deps.outbox.register("feed.poll", feeds.handler);
  const scheduler = createScheduler({
    outbox: deps.outbox,
    precheck: precheckStep,
    db: deps.db,
    clock: deps.clock,
    logger,
    triggers,
    store: triggerStore,
    fire: built.fire,
    readOnly: deps.readOnly,
    tasks: built.store,
  });
  late.scheduler = scheduler;
  built.agentTasks.onDelayed(() => scheduler.armDue());
  const releaseTools = createReleaseTools({
    store: built.store,
    clock: deps.clock,
    audit: deps.audit,
    policy: deps.policy,
    sessions: deps.sessions,
    requireStepUp: deps.requireStepUp,
    announce: (row) => built.runner.announce(row.id, row.state),
  });
  const housekeeping = createHousekeeping({
    db: deps.db,
    clock: deps.clock,
    logger,
    store: built.store,
    outbox: deps.outbox,
    sessions: deps.sessions,
    timeZone: () => {
      const owner = deps.db.get<{ owner_id: string }>(
        "SELECT owner_id FROM triggers ORDER BY created_at LIMIT 1",
      );
      return owner ? deps.settings.automation(owner.owner_id).timezone : null;
    },
    inboxRetention: deps.inboxRetention,
    readOnly: deps.readOnly,
    dropScratch: createAgentScratchDropper(() => agents.ports(), logger),
    sweepScratch: createAgentScratchSweeper({
      ports: () => agents.ports(),
      hasTask: built.store.exists,
      logger,
    }),
  });
  const threadQueue = createThreadQueue({
    db: deps.db,
    clock: deps.clock,
    logger,
    binding: agents,
    store: built.store,
    outbox: deps.outbox,
    events: built.events,
    views: built.views,
    newId: randomUUID,
  });
  const triggerLink = createAgentTriggerLink({
    store: triggerStore,
    secretsDir: triggerSecretsDir(deps.config.home),
    changed: triggerChanged,
    logger,
    rotate: (caller, triggerId) => triggers.rotateSecret(caller, triggerId, true),
  });
  return {
    events: built.events,
    taskOf(ownerId, sessionId) {
      const row = built.store.bySession(sessionId);
      // An ended task leaves its session to the owner: a later quota resume there is an ordinary one.
      if (!row || row.owner_id !== ownerId || (row.state !== "limited" && row.state !== "running"))
        return null;
      return { taskId: row.id, overBudget: built.gates.taskOver(ownerId, row) };
    },
    taskInfo(taskId) {
      const row = built.store.get(taskId);
      return row
        ? {
            ownerId: row.owner_id,
            triggerName: row.trigger_name ?? row.title,
            sessionId: row.session_id,
            agentId: row.agent_id,
          }
        : null;
    },
    agentLink: createAgentLink({
      taskLink: built.taskLink,
      deleteTriggersOf: triggerLink.deleteTriggersOf,
      rotateSecretsOf: triggerLink.rotateSecretsOf,
      queue: threadQueue.queue,
      store: built.store,
      views: built.views,
      triggerStore,
      triggers,
    }),
    bindAgents: built.bindAgents,
    agentTasks: built.agentTasks,
    rpc: automationRpc(triggers, taskActions(built.runner, built.stream, releaseTools), {
      manual: createManual({
        db: deps.db,
        clock: deps.clock,
        logger,
        fire: built.fire,
        triggers,
        settings: deps.settings,
        gates: built.gates,
        precheck: deps.precheck,
        agents,
      }),
      dryRun: createDryRun({
        clock: deps.clock,
        logger,
        triggers,
        store: built.store,
        gates: built.gates,
        settings: deps.settings,
        precheck: deps.precheck,
        agents,
      }),
      journal: createJournal({ db: deps.db, triggers, runs: deps.runs }),
    }),
    triggers: { get: triggers.get, getAt: triggers.getAt, listEnabled: triggers.listEnabled },
    fire: built.fire,
    mountHooks: (app) =>
      mountHookRoute(app, {
        clock: deps.clock,
        logger,
        readOnly: deps.readOnly,
        secretsDir: triggerSecretsDir(deps.config.home),
        find: (id) => {
          const ownerId = triggerStore.ownerOf(id);
          return ownerId === undefined ? null : triggers.get(ownerId, id);
        },
        fire: built.fire,
        backoff,
        rate,
        journal: createHookJournal({ db: deps.db, clock: deps.clock, logger }),
      }),
    recover: built.recover,
    start() {
      housekeeping.start();
      scheduler.start();
    },
    stop: async () => {
      scheduler.stop();
      feeds.stop();
      deps.precheck?.stop?.();
      housekeeping.stop();
      built.stop();
    },
  };
}
