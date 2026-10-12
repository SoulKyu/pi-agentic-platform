import { DEFAULT_GUARD, PolicyRules, type PolicySettings, type SessionPolicyView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../audit/index.ts";
import { type PolicyPort, RESTRICTIVE_SETTINGS } from "../policy/index.ts";
import { createGrantLink, type GrantLink } from "./grants.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";

const SAY_EVERY_MS = 60_000;

export interface PolicyLinkDeps {
  readonly policy: PolicyPort;
  readonly audit: AuditPort;
  /** What the daemon knows of the workers' containment: "scope" when each runs in a systemd scope. */
  readonly containment: "scope" | "none";
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  /** The workers that are up and the ones still starting. */
  sessions(): Iterable<LiveSession>;
}

export interface PolicyLink {
  readonly grants: GrantLink;
  /** The whole rules of a session's worker (M5R58). Always valid: a bug in the parts gives read-only rules. */
  compose(row: SessionRow, scope: string): PolicyRules;
  /** The mode in force, whether the session chose it, and whether it is tainted: what a snapshot and a `policy` event carry. */
  viewOf(row: SessionRow): SessionPolicyView;
  /** A worker's audit record (as unknown) goes to the audit module. */
  audited(row: SessionRow, raw: unknown): void;
  /** The worker refused a policy update (M5R11): it blocks every call, so it is stopped and the next prompt starts a worker with composed rules. */
  refused(row: SessionRow, session: LiveSession): void;
  stop(): void;
}

/**
 * What ties the sessions to the policy module: the rules each worker gets and is pushed (M5R58, M5R59), the session's
 * policy view for the snapshot and the `policy` event (M5R61), the audit hand-over, and a worker that refused an update.
 */
export function createPolicyLink(deps: PolicyLinkDeps): PolicyLink {
  const limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  const say = (code: string, fields: Record<string, unknown>) => {
    const { allowed, suppressed } = limiter.check(code);
    if (allowed) deps.logger.warn(code, { ...fields, ...(suppressed > 0 ? { suppressed } : {}) });
  };

  // The owner's settings, or the restrictive ones when the port cannot read them: a worker is never started without.
  function settingsOf(row: SessionRow): PolicySettings {
    try {
      return deps.policy.settings(row.ownerId);
    } catch (error) {
      say("policy_settings_failed", { sessionId: row.id, err: error });
      return RESTRICTIVE_SETTINGS;
    }
  }

  const grants: GrantLink = createGrantLink({
    policy: deps.policy,
    clock: deps.clock,
    logger: deps.logger,
    sessions: deps.sessions,
    compose: (row, scope) => compose(row, scope),
  });

  function compose(row: SessionRow, scope: string): PolicyRules {
    const { mode, taint } = deps.policy.sessionPolicy(row.ownerId, row.id);
    const settings = settingsOf(row);
    const composed = PolicyRules.safeParse({
      profile: "interactive",
      approvalMode: mode,
      alwaysAllow: grants.alwaysFor(row, scope),
      builtinDenylist: settings.builtinDenylist,
      denylist: settings.denylist,
      allowHosts: settings.allowHosts,
      guard: DEFAULT_GUARD,
      taint,
    });
    if (composed.success) return composed.data;
    // A bug, not an answer. The worker refuses invalid rules at start, and read-only is the narrowest valid set.
    say("policy_rules_invalid", { sessionId: row.id });
    return { profile: "interactive", approvalMode: "read-only", taint } as PolicyRules;
  }

  const viewOfId = (ownerId: string, sessionId: string): SessionPolicyView => {
    const { mode, explicit, taint } = deps.policy.sessionPolicy(ownerId, sessionId);
    return { mode, explicit, tainted: taint.tainted };
  };
  const publishView = (ownerId: string, sessionId: string): void =>
    deps.hub.publish("session", sessionId, { kind: "policy", policy: viewOfId(ownerId, sessionId) });

  // The push to the worker goes first (synchronously), then the event: whoever sees the new view finds the worker holding it.
  const unlistenSession = deps.policy.onSessionChange((ownerId, sessionId) => {
    grants.pushWhere((row) => row.id === sessionId);
    publishView(ownerId, sessionId);
  });
  const unlistenSettings = deps.policy.onSettingsChange((ownerId) => {
    grants.pushWhere((row) => row.ownerId === ownerId);
    for (const row of grants.rowsWhere((tracked) => tracked.ownerId === ownerId))
      publishView(ownerId, row.id);
  });

  return {
    grants,
    compose,
    viewOf: (row) => viewOfId(row.ownerId, row.id),
    audited: (row, raw) => void deps.audit.fromWorker(row, raw, { containment: deps.containment }),
    refused(row, session) {
      say("policy_update_refused", { sessionId: row.id });
      session.stop().catch((error: unknown) => {
        deps.logger.warn("worker_stop_failed", { sessionId: row.id, err: error });
      });
    },
    stop() {
      unlistenSession();
      unlistenSettings();
      grants.stop();
    },
  };
}
