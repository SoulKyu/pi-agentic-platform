import type { Hono } from "hono";
import {
  type AutomationModules,
  composeAutomation,
  composeOutbox,
  type M10Core,
} from "./compose-automation.ts";
import {
  composeMetrics,
  composeRuns,
  type ComposedMetrics,
  registerAttachmentCleanup,
} from "./compose-runs.ts";
import { composeTrace, type ComposedTrace } from "./compose-trace.ts";
import { composeSessionCost } from "./compose-session-cost.ts";
import { composeUsage } from "./compose-usage.ts";
import type { MigrationSource } from "./kernel/db/migrate.ts";
import type { Outbox } from "./kernel/outbox/index.ts";
import {
  AUTOMATION_MIGRATIONS,
  type AutomationModule,
  type AutomationRpc,
  type FireResult,
} from "./modules/automation/index.ts";
import { composeHealth } from "./compose-health.ts";
import type { HealthModule } from "./modules/health/index.ts";
import { type Inbox, INBOX_MIGRATIONS, inboxRpc, type InboxRpc } from "./modules/inbox/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";
import {
  RUNS_MIGRATIONS,
  type RunObserver,
  runsRpc,
  type RunsRpc,
  type RunsService,
  type UsageRpc,
} from "./modules/runs/index.ts";

export type { M10Core } from "./compose-automation.ts";

/** The migration sources of M10's modules (automation and inbox; runs). The outbox table is the kernel's own. */
export const M10_MIGRATION_SOURCES: readonly MigrationSource[] = [
  AUTOMATION_MIGRATIONS,
  RUNS_MIGRATIONS,
  INBOX_MIGRATIONS,
];

export interface M10Early {
  readonly outbox: Outbox;
  /** The runs registry; its port is what the budget, the runner and the compare column read. */
  readonly runs: RunsService;
  /** What the sessions module is given: it feeds the registry each run and raw Pi event (M10R84). */
  readonly observer: RunObserver;
  /** The trace file and the stall monitor; `onCall` goes to the dispatcher. */
  readonly trace: ComposedTrace;
  readonly onCall: ComposedTrace["onCall"];
  /** `GET /metrics` and its families (Task 14). */
  readonly metrics: ComposedMetrics;
  /** The health module (Task 4): the daemon's one bus, the `ops` stream and the outbox's failures. */
  readonly health: HealthModule;
}

/** The modules `composeM10` is given once they exist; the tasks that need one read it from here. */
export type M10Modules = AutomationModules &
  Readonly<Record<string, unknown>> & {
    readonly settings: SettingsModule;
    readonly sessions: Pick<SessionsModule, "automation" | "modeOf" | "sandboxedThread" | "kindOf" | "cost">;
  };

export interface M10 {
  readonly outbox: Outbox;
  readonly automation: AutomationModule;
  /** M10's Inbox; M11 writes its agent items through it. */
  readonly inbox: Inbox;
  /** M10's RPC methods; each task adds its table here, never in `daemon.ts`. */
  readonly rpc: AutomationRpc & RunsRpc & InboxRpc & UsageRpc;
  /**
   * Fires a trigger as the owner's own manual fire (M10R57: a disabled trigger is not in the way), without a caller, a
   * precheck or a payload. Kept as test support only: the scripted-provider integration tests start tasks with it. The
   * real path is `automation.fire` (`modules/automation/manual.ts`); the dispatcher never reaches this.
   */
  fireManual(ownerId: string, triggerId: string): FireResult;
  mount(app: Hono): void;
  /** After `startServer`: arms the timers. */
  start(): void;
  /** First in the daemon's stop (C3): no new effect starts; in-flight handlers are aborted and awaited. */
  stop(): Promise<void>;
}

/** The daemon's list of things to undo, in the order they were pushed; undone in reverse after the workers stop. */
interface Closers {
  push(closer: { readonly name: string; close(): void | Promise<void> }): unknown;
}

/** Before any module is built: recovers the outbox (M10R11) and the runs a crash left open (M10R88). */
export function composeM10Early(core: M10Core, closers?: Closers): M10Early {
  const runs = composeRuns(core);
  const trace = composeTrace(core);
  // Last of the daemon's stop (C3): after the workers are gone, so the stop's own spans are exported or counted.
  closers?.push({
    name: "trace_export",
    close: async () => {
      await trace.exporter?.close();
      trace.close();
    },
  });
  const outbox = composeOutbox(core, trace.tracer);
  const health = composeHealth(core, outbox);
  closers?.push({ name: "health", close: () => health.stop() });
  return {
    outbox,
    health,
    runs: runs.service,
    observer: runs.observer,
    trace,
    onCall: trace.onCall,
    metrics: composeMetrics(core, runs.service, trace),
  };
}

/**
 * Tests only: the manual fire of a daemon that runs the scripted provider, by home (`automation.fire` is the real path).
 * Nothing registers outside a test config, and `stop()` removes the entry.
 */
const SEAMS = new Map<string, (triggerId: string) => FireResult>();
export const fireManualOf = (home: string) => SEAMS.get(home);

export function composeM10(core: M10Core, early: M10Early, modules: M10Modules): M10 {
  const { outbox } = early;
  // Cancel of a limited task retires its pending resume: the planner is built after the module, so its keys are read late.
  const late: { usage?: ReturnType<typeof composeUsage> } = {};
  const { automation, inbox } = composeAutomation(core, modules, early, {
    keysOf: (sessionId) => late.usage?.resume.keysOf(sessionId) ?? [],
    sending: (sessionId) => late.usage?.resume.sending(sessionId) ?? false,
  });
  const usage = (late.usage = composeUsage(core, early, modules, automation.taskOf));
  registerAttachmentCleanup(core, outbox, modules.sessions.automation);
  const stopSessionCost = composeSessionCost(early.runs, modules.sessions);
  early.metrics.bind({
    settings: { automation: (ownerId) => modules.settings.port.automation(ownerId) },
    workers: () => modules.sessions.automation.workers(),
  });
  const m10: M10 = {
    outbox,
    automation,
    inbox,
    fireManual(ownerId, triggerId) {
      const trigger = automation.triggers.get(ownerId, triggerId);
      if (!trigger) return { verdict: "error", detail: "changed" };
      return automation.fire(trigger.id, trigger.revision, {
        ownerId,
        source: "manual",
        payload: null,
        dedupKey: null,
        title: trigger.name,
        detail: null,
        gated: false,
        gates: { exemptDisabled: true },
        retry: null,
      });
    },
    rpc: {
      ...automation.rpc,
      ...inboxRpc(inbox),
      ...runsRpc(early.runs.port, (ownerId) => modules.settings.port.automation(ownerId).timezone),
      ...usage.rpc,
    },
    mount: (app) => {
      early.metrics.mount(app);
      automation.mountHooks(app);
    },
    start() {
      outbox.start();
      automation.start();
      early.trace.stall.start();
      early.trace.exporter?.start();
    },
    stop: async () => {
      inbox.stop();
      await automation.stop();
      await outbox.stop();
      early.trace.stall.stop();
      SEAMS.delete(core.config.home);
      usage.stop();
      stopSessionCost();
    },
  };
  if (core.config.testProviderScript)
    SEAMS.set(core.config.home, (triggerId) => {
      const owner = core.db.get<{ owner_id: string }>("SELECT owner_id FROM triggers WHERE id = $triggerId", {
        triggerId,
      });
      return m10.fireManual(owner?.owner_id ?? "", triggerId);
    });
  return m10;
}
