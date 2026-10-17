import {
  type ApprovalMode,
  type Caller,
  DEFAULT_GUARD,
  PolicyRules,
  type PolicySettings,
  type SessionPolicyView,
} from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../audit/index.ts";
import { type PolicyPort, RESTRICTIVE_SETTINGS } from "../policy/index.ts";
import { type AgentRuleParts, effectiveMode, type OwnerLists } from "./agent-rules.ts";
import { auditActorOf, taskRules } from "./automation-port.ts";
import { createGrantLink, type GrantLink } from "./grants.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow, StoredPreset } from "./store.ts";

const SAY_EVERY_MS = 60_000;
const MAX_WINDOWS = 1_024;
/** Answers whose audit row has not come yet; the oldest is forgotten past this (a row that never comes must not pile up). */
const MAX_ANSWERERS = 1_024;

/** Who answered a question: a browser session (`user`) or a token. */
export interface Answerer {
  readonly actor: "user" | "token" | "system";
  readonly actorId: string;
}

/**
 * The least an audit record must say to taint the session (M5R60, path 2): checked before the full audit schema, so an
 * entry the schema refuses still taints. It carries no epoch, so it raises whatever a clear did, on purpose: it is the
 * safeguard for external content a worker reads between a Clear and the new epoch reaching it. A late entry that
 * re-taints is a nuisance, never unsafe. Never add an epoch check to this path: that would turn it into a fail-open.
 */
const CallDecision = z.object({
  kind: z.literal("call"),
  toolCallId: z.string().max(256),
  decision: z.enum(["approved", "denied"]),
});
export const TaintFact = z.object({ kind: z.literal("result"), external: z.literal(true) });

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
  /** The session's tool preset now (null: configured): the stored one, not the copy a tracked row holds (Task 15). */
  toolPreset(row: SessionRow): StoredPreset | null;
  /** The agent's part of the rules of a session that belongs to one (M11R52); none: nothing is added. */
  agentRules?(row: SessionRow, owner: OwnerLists): AgentRuleParts;
  /** The mode of the profile of an agent thread, for the `policy` view (W5-R23); null for any other session. */
  agentModeOf?(ownerId: string, sessionId: string): ApprovalMode | null;
}

export interface PolicyLink {
  readonly grants: GrantLink;
  /** The whole rules of a session's worker (M5R58). Always valid: a bug in the parts gives read-only rules. */
  compose(row: SessionRow, scope: string): PolicyRules;
  /** The mode in force, whether the session chose it, and whether it is tainted: what a snapshot and a `policy` event carry. */
  viewOf(row: SessionRow): SessionPolicyView;
  /** A worker's audit record (as unknown) goes to the audit module; one that says `external` taints the session first. */
  audited(row: SessionRow, raw: unknown): void;
  /** The credential that answered the question about `toolCallId`: the call's audit row, when it comes, names it once. */
  answeredBy(row: SessionRow, toolCallId: string, caller: Caller): void;
  /** The worker's own taint report with its epoch (M5R60): stored unless a clear came after it. The port's listener pushes and publishes. */
  tainted(row: SessionRow, epoch: number): void;
  /** A fork or clone takes its source's mode and taint (owner Q15). A throw is the caller's to handle. */
  inherit(source: SessionRow, targetId: string): void;
  /** The worker refused a policy update (M5R11): it blocks every call, so it is stopped and the next prompt starts a worker with composed rules. */
  refused(row: SessionRow, session: LiveSession): void;
  stop(): void;
}

/**
 * What ties the sessions to the policy module: the rules each worker gets and is pushed (M5R58, M5R59), the session's
 * policy view for the snapshot and the `policy` event (M5R61), the audit hand-over, and a worker that refused an update.
 */
export function createPolicyLink(deps: PolicyLinkDeps): PolicyLink {
  let limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  const windows = new Set<string>();
  const answerers = new Map<string, Answerer>();
  const takeAnswerer = (row: SessionRow, raw: unknown): Answerer | undefined => {
    const entry = CallDecision.safeParse(raw);
    if (!entry.success) return undefined;
    const key = `${row.id}:${entry.data.toolCallId}`;
    const found = answerers.get(key);
    answerers.delete(key);
    return found;
  };
  // One window per code and session, so every session is named. The windows start over when MAX_WINDOWS are held.
  const say = (code: string, fields: Record<string, unknown>) => {
    const key = `${code}:${String(fields.sessionId ?? "")}`;
    if (!windows.has(key) && windows.size >= MAX_WINDOWS) {
      windows.clear();
      limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
    }
    windows.add(key);
    const { allowed, suppressed } = limiter.check(key);
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
    const { mode, taint, ...task } = deps.policy.sessionPolicy(row.ownerId, row.id);
    const settings = settingsOf(row);
    const composed = PolicyRules.safeParse({
      profile: "interactive",
      approvalMode: mode,
      alwaysAllow: grants.alwaysFor(row, scope),
      ...grants.patternsFor(row, scope),
      builtinDenylist: settings.builtinDenylist,
      denylist: settings.denylist,
      allowHosts: settings.allowHosts,
      guard: DEFAULT_GUARD,
      taint,
      readOnlyCommands: settings.readOnlyCommands,
      readOnlyPreset: deps.toolPreset(row) === "read-only",
      ...taskRules(row, { mode, ...task }),
      ...deps.agentRules?.(row, {
        allowHosts: settings.allowHosts,
        denylist: settings.denylist,
        session: { mode, explicit: task.explicit },
      }),
    });
    if (composed.success) return composed.data;
    // A bug, not an answer. The worker refuses invalid rules at start, and read-only is the narrowest valid set.
    say("policy_rules_invalid", { sessionId: row.id });
    return { profile: "interactive", approvalMode: "read-only", taint } as PolicyRules;
  }

  // A taint that cannot be stored is logged; the worker keeps its own and repeats it at its next agent_end.
  function markTainted(row: SessionRow, epoch?: number): void {
    try {
      deps.policy.markTainted(row.ownerId, row.id, epoch);
    } catch (error) {
      say("taint_not_stored", { sessionId: row.id, err: error });
    }
  }

  const defaultModeOf = (ownerId: string, sessionId: string): ApprovalMode => {
    try {
      return deps.policy.settings(ownerId).defaultMode;
    } catch (error) {
      say("policy_settings_failed", { sessionId, err: error });
      return RESTRICTIVE_SETTINGS.defaultMode;
    }
  };

  const viewOfId = (ownerId: string, sessionId: string): SessionPolicyView => {
    const session = deps.policy.sessionPolicy(ownerId, sessionId);
    const agentMode = deps.agentModeOf?.(ownerId, sessionId) ?? null;
    // On an agent thread the view shows the mode in force (W5-R23).
    const { mode, explicit } = agentMode === null ? session : effectiveMode(agentMode, session);
    return { mode, explicit, tainted: session.taint.tainted, defaultMode: defaultModeOf(ownerId, sessionId) };
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
    audited(row, raw) {
      if (TaintFact.safeParse(raw).success) markTainted(row);
      const answeredBy = takeAnswerer(row, raw);
      void deps.audit.fromWorker(row, raw, {
        containment: deps.containment,
        ...(answeredBy ? { answeredBy } : {}),
      });
    },
    answeredBy(row, toolCallId, caller) {
      if (answerers.size >= MAX_ANSWERERS) {
        const oldest = answerers.keys().next();
        if (!oldest.done) answerers.delete(oldest.value);
      }
      answerers.set(`${row.id}:${toolCallId}`, {
        actor: auditActorOf(caller),
        actorId: caller.credentialId ?? "",
      });
    },
    tainted: (row, epoch) => markTainted(row, epoch),
    inherit: (source, targetId) => deps.policy.inherit(source.ownerId, source.id, targetId),
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
