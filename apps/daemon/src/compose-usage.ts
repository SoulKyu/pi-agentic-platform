import type { M10Core } from "./compose-automation.ts";
import type { Outbox } from "./kernel/outbox/index.ts";
import type { PolicyModule } from "./modules/policy/index.ts";
import {
  createResume,
  type ResumeDeps,
  createUsageStream,
  type Resume,
  type RunsService,
  usageRpc,
  type UsageRpc,
  type UsageStream,
} from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

export interface ComposedUsage {
  readonly rpc: UsageRpc;
  readonly resume: Resume;
  readonly stream: UsageStream;
  /** The pending `spend` timers and the test seam. */
  stop(): void;
}

/**
 * Tests only: runs the outbox's due effects now, by home (the integration test moves a clock past a quota reset and
 * drains). Registered for a daemon on the scripted provider; `stop()` removes it.
 */
const DRAINS = new Map<string, () => Promise<number>>();
export const drainOutboxOf = (home: string) => DRAINS.get(home);

/**
 * Quota limits (Task 17): the `run.resume` handler and its planner, the `usage` stream and its three methods. Built over
 * the modules the daemon has by then; each call into them is lazy, since the runs are closed long after composition.
 */
export function composeUsage(
  core: M10Core,
  early: { readonly outbox: Outbox; readonly runs: RunsService },
  modules: {
    readonly policy: Pick<PolicyModule, "port">;
    readonly settings: SettingsModule;
    readonly sessions: Pick<SessionsModule, "automation">;
  },
  taskOf?: ResumeDeps["taskOf"],
): ComposedUsage {
  const { outbox, runs } = early;
  const settings = (ownerId: string) => modules.settings.port.automation(ownerId);
  const stream = createUsageStream({
    hub: core.hub,
    clock: core.clock,
    logger: core.logger,
    runs,
    port: runs.port,
    outbox,
    settings,
  });
  const resume = createResume({
    clock: core.clock,
    logger: core.logger,
    runs,
    port: runs.port,
    outbox,
    settings,
    taskOf,
    modeOf: (ownerId, sessionId) => modules.policy.port.sessionPolicy(ownerId, sessionId).mode,
    sessions: modules.sessions.automation,
    limitChanged: stream.refresh,
  });
  resume.attach();
  if (core.config.testProviderScript) DRAINS.set(core.config.home, () => outbox.drain());
  return {
    rpc: usageRpc(resume),
    resume,
    stream,
    stop() {
      stream.stop();
      DRAINS.delete(core.config.home);
    },
  };
}
