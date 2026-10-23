import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import type { Logger } from "./kernel/logger.ts";
import type { Tracer } from "./kernel/observability/tracer.ts";
import { createOutbox, type Outbox } from "./kernel/outbox/index.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type { AuditModule } from "./modules/audit/index.ts";
import type { HealthModule } from "./modules/health/index.ts";
import { createInbox, type Inbox } from "./modules/inbox/index.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import {
  type AutomationDeps,
  type AutomationModule,
  createAutomationModule,
} from "./modules/automation/index.ts";
import type { PolicyModule } from "./modules/policy/index.ts";
import type { ProjectsModule } from "./modules/projects/index.ts";
import type { RunsService } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

/** What the M10 composition files share with `daemon.ts` (M10R15): the kernel's handles, before any module exists. */
export interface M10Core {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: Config;
  readonly readOnly: boolean;
  readonly hub: StreamHub;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The outbox, recovered before it is returned (spec C §6.3): `daemon.ts` calls this before any module is built, so no
 * module can enqueue or see a row of the previous life. Read-only: no recovery, no worker (M10R150).
 */
export function composeOutbox(core: M10Core, tracer?: Tracer): Outbox {
  const outbox = createOutbox({
    db: core.db,
    clock: core.clock,
    logger: core.logger,
    readOnly: core.readOnly,
    hold: core.config.testOutboxHold ?? null,
    span: tracer && ((kind) => tracer.span(`outbox.${kind}`)),
  });
  outbox.recover();
  return outbox;
}

/** The modules the automation module is built over; the daemon builds them before `composeM10`. */
export interface AutomationModules {
  readonly audit: Pick<AuditModule, "port">;
  readonly policy: Pick<PolicyModule, "port">;
  /** `boxSource`: the owner's box projects, so a trigger or a task in a box root is never run from the host (boxes B1). */
  readonly projects: Pick<ProjectsModule, "port"> & Partial<Pick<ProjectsModule, "boxSource">>;
  readonly sessions: Pick<SessionsModule, "automation">;
  readonly settings: Pick<SettingsModule, "port">;
}

/** What the daemon built before any module: the recovered outbox, the runs registry, and the health module. */
export interface AutomationEarly {
  readonly outbox: Outbox;
  readonly runs: Pick<RunsService, "port">;
  /** The trace file: the feed fetch's span. */
  readonly trace?: { readonly tracer: Tracer };
  /** The daemon's one health bus (Task 4); absent and the engine makes its own. */
  readonly health?: HealthModule;
}

/**
 * The automation module over the kernel's handles and the modules it reads, and the Inbox that listens to it (M10R46).
 * The tasks' boot recovery runs here (M10R42): after the outbox and the runs recovered, before the server listens.
 * Later tasks add their deps here.
 */
export function composeAutomation(
  core: M10Core,
  modules: AutomationModules,
  early: AutomationEarly,
  resume?: AutomationDeps["resume"],
): { readonly automation: AutomationModule; readonly inbox: Inbox } {
  // The housekeeping is built inside the automation module and the Inbox needs its events: bound late.
  const late: { inbox?: Inbox } = {};
  const automation = createAutomationModule({
    db: core.db,
    clock: core.clock,
    logger: core.logger,
    audit: modules.audit.port,
    projects: modules.projects.port,
    ...(modules.projects.boxSource ? { boxes: () => modules.projects.boxSource } : {}),
    policy: modules.policy.port,
    config: core.config,
    requireStepUp,
    readOnly: core.readOnly,
    sessions: modules.sessions.automation,
    runs: early.runs.port,
    settings: modules.settings.port,
    outbox: early.outbox,
    hub: core.hub,
    health: early.health?.port,
    inboxRetention: () => late.inbox?.retention(),
    resume,
    feedSpan: early.trace && (() => (early.trace as { tracer: Tracer }).tracer.span("feed.fetch")),
  });
  const inbox = createInbox({
    db: core.db,
    clock: core.clock,
    logger: core.logger.child({ module: "inbox" }),
    hub: core.hub,
    events: automation.events,
    tasks: { find: automation.taskInfo },
    readOnly: core.readOnly,
  });
  late.inbox = inbox;
  automation.recover();
  return { automation, inbox };
}
