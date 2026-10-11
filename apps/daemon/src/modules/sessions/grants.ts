import { type AlwaysRule, type ApprovalAnswer, MAX_ALWAYS_RULES, type PolicyRules } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { Grant } from "./dialogs.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";

/** A notice about an "always" answer that could not be kept is said at most once per session in this window. */
export const GRANT_NOTICE_EVERY_MS = 60_000;
/**
 * The most JSON a worker is given as rules. 1000 rules at their widest (a 256-character tool name that escapes to
 * six bytes a character) come to about 1.6 MB, and the worker refuses a record over 4 MiB: this keeps a rule list
 * that grew past what the policy module bounds from becoming a record the worker drops (or a worker that will not start).
 */
export const MAX_POLICY_BYTES = 2 * 1024 * 1024;
const LOG_EVERY_MS = 60_000;

interface Launched {
  readonly row: SessionRow;
  readonly scope: string;
  noticeAt: number | null;
}

export interface GrantLinkDeps {
  readonly policy: PolicyPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  /** The workers that are up and the ones still starting: a rule change reaches both (ADR 0001, M2R75). */
  sessions(): Iterable<LiveSession>;
}

/**
 * What ties a session's worker to the project's "always" rules: the rules in its `init`, the pushes when a rule is
 * added or revoked, and what happens to an "always" answer. The row and project of each session sit in a WeakMap
 * beside its `LiveSession`, so nothing needs cleaning when a session goes (M2-RT-25).
 */
export function createGrantLink(deps: GrantLinkDeps) {
  const launched = new WeakMap<LiveSession, Launched>();
  const limiter = createRateLimiter(deps.clock, LOG_EVERY_MS);
  // A fixed set of codes, each said at most once per window; the count of those left out goes with the next.
  const say = (code: string, fields: Record<string, unknown> = {}) => {
    const { allowed, suppressed } = limiter.check(code);
    if (allowed) deps.logger.warn(code, { ...fields, ...(suppressed > 0 ? { suppressed } : {}) });
  };

  // Fails closed: rules that are over what a worker takes are not sent in part, none of them is, so the worker asks again.
  function policyFor(row: SessionRow, scope: string): PolicyRules {
    const rules: AlwaysRule[] = deps.policy.rulesFor(row.ownerId, scope);
    const fits = rules.length <= MAX_ALWAYS_RULES && sizeOf(rules) <= MAX_POLICY_BYTES;
    if (!fits) say("policy_rules_too_large", { sessionId: row.id, count: rules.length });
    return { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: fits ? rules : [] };
  }

  // A worker that cannot be told keeps a rule that may be revoked: it is stopped, and the next prompt starts one with the current rules.
  function push(session: LiveSession, at: Launched): void {
    let sent = false;
    try {
      sent = session.send({ type: "policy_update", rules: policyFor(at.row, at.scope) });
    } catch (error) {
      deps.logger.warn("policy_update_failed", { sessionId: at.row.id, err: error });
    }
    if (sent) return;
    say("policy_update_not_sent", { sessionId: at.row.id });
    session.stop().catch((error: unknown) => {
      deps.logger.warn("policy_update_stop_failed", { sessionId: at.row.id, err: error });
    });
  }

  const unlisten = deps.policy.onChange((ownerId, scope) => {
    for (const session of [...deps.sessions()]) {
      const at = launched.get(session);
      if (at && at.row.ownerId === ownerId && at.scope === scope) push(session, at);
    }
  });

  function tellSessionOnly(at: Launched, text: string): void {
    const now = deps.clock.now();
    if (at.noticeAt !== null && now - at.noticeAt < GRANT_NOTICE_EVERY_MS) return;
    at.noticeAt = now;
    deps.hub.publish("session", at.row.id, { kind: "notice", level: "warning", text });
  }

  return {
    scopeOf: (cwd: string): string => deps.policy.scopeOf(cwd),
    policyFor,
    /** Called right after the session's worker was started, before anything can await. */
    track(session: LiveSession, row: SessionRow, scope: string): void {
      launched.set(session, { row, scope, noticeAt: null });
    },
    /**
     * After an answer reached the worker. An "always" answer becomes a rule; the push that follows is what ends the
     * worker's provisional grant. When no rule can be made the grant is the worker's alone, until the next update.
     */
    answered(session: LiveSession, approved: { answer: ApprovalAnswer; grant: Grant } | null): void {
      if (approved?.answer !== "always") return;
      const at = launched.get(session);
      if (!at) {
        say("always_rule_not_saved", { reason: "session_not_tracked" });
        return;
      }
      try {
        const added = deps.policy.addAlways({ ownerId: at.row.ownerId, scope: at.scope, ...approved.grant });
        if (added === "full") {
          tellSessionOnly(
            at,
            "This project already has 1000 always-allowed calls: this one is allowed for the session only.",
          );
        }
      } catch (error) {
        // A bug signal (a value outside its bounds), not an answer: no rule, the call the person allowed proceeds.
        say("always_rule_not_saved", { sessionId: at.row.id, err: error });
        tellSessionOnly(at, "This call is allowed for the session only: the always rule could not be saved.");
      }
    },
    stop: unlisten,
  };
}
