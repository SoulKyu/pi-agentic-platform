import { AlwaysRule, type ApprovalAnswer, MAX_ALWAYS_RULES, type PolicyRules } from "@pap/contracts";
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
 * The most JSON a worker is given as rules. Nothing caps what a worker receives (its 4 MiB record limit is for what
 * it sends), so this is a defence of its own: 1000 rules at their widest (a 256-character tool name that escapes to
 * six bytes a character) come to about 1.6 MB, and a list past this is sent as no rule at all.
 */
export const MAX_POLICY_BYTES = 2 * 1024 * 1024;
// English only, like every daemon notice; the web shows the text as it is.
export const FULL_NOTICE = `This project already has ${MAX_ALWAYS_RULES} always-allowed calls: this one is allowed until this project's rules change.`;
export const NOT_SAVED_NOTICE =
  "This call is allowed until this project's rules change: its always rule could not be saved.";
const LOG_EVERY_MS = 60_000;

interface Launched {
  readonly row: SessionRow;
  readonly scope: string;
  noticeAt: number | null;
  /** The worker has said `ready`. Until then a change only marks `dirty`: one update goes out after `ready`. */
  ready: boolean;
  /** The rules the worker holds are older than the project's. */
  dirty: boolean;
  scheduled: boolean;
}

/** The rules as they are, or null when there are more than the policy module keeps or they come to more than `maxBytes` of JSON. */
export function fitRules(rules: AlwaysRule[], maxBytes = MAX_POLICY_BYTES): AlwaysRule[] | null {
  return rules.length <= MAX_ALWAYS_RULES && sizeOf(rules) <= maxBytes ? rules : null;
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
  // A stored rule outside the schema is skipped alone, so one bad row cannot keep a project's workers from starting.
  function policyFor(row: SessionRow, scope: string): PolicyRules {
    const stored: AlwaysRule[] = deps.policy.rulesFor(row.ownerId, scope);
    const rules = stored.filter((rule) => AlwaysRule.safeParse(rule).success);
    if (rules.length !== stored.length) {
      say("policy_rule_invalid", { sessionId: row.id, skipped: stored.length - rules.length });
    }
    const fitted = fitRules(rules);
    if (!fitted) say("policy_rules_too_large", { sessionId: row.id, count: rules.length });
    return { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: fitted ?? [] };
  }

  // A worker that cannot be told keeps a rule that may be revoked: it is stopped, and the next prompt starts one with the current rules.
  function flush(session: LiveSession, at: Launched): void {
    if (!at.dirty || session.status() === "cold") return;
    at.dirty = false;
    let sent = false;
    try {
      sent = session.send({ type: "policy_update", rules: policyFor(at.row, at.scope) });
    } catch (error) {
      say("policy_update_failed", { sessionId: at.row.id, err: error });
    }
    if (sent) return;
    say("policy_update_not_sent", { sessionId: at.row.id });
    session.stop().catch((error: unknown) => {
      deps.logger.warn("policy_update_stop_failed", { sessionId: at.row.id, err: error });
    });
  }

  // Every update carries the whole list, so only the latest matters: a burst of changes is one update per worker, sent
  // once the burst's tick is over, and a worker still starting gets its one update right after `ready` (it holds at
  // most 128 records before then).
  function markDirty(session: LiveSession, at: Launched): void {
    at.dirty = true;
    if (!at.ready || at.scheduled) return;
    at.scheduled = true;
    queueMicrotask(() => {
      at.scheduled = false;
      flush(session, at);
    });
  }

  const unlisten = deps.policy.onChange((ownerId, scope) => {
    for (const session of [...deps.sessions()]) {
      const at = launched.get(session);
      if (at && at.row.ownerId === ownerId && at.scope === scope) markDirty(session, at);
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
      const at: Launched = { row, scope, noticeAt: null, ready: false, dirty: false, scheduled: false };
      launched.set(session, at);
      // Registered before the caller awaits `ready`, so the update is out before the caller can hand the worker a prompt.
      session.ready.then(
        () => {
          at.ready = true;
          flush(session, at);
        },
        () => {},
      );
    },
    /**
     * After an answer reached the worker. An "always" answer becomes a rule; the push that follows is what ends the
     * worker's provisional grant, unless it was taken at the answer (the grant is stamped when the question is asked).
     * When no rule can be made the grant lasts only until the worker's next policy update.
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
          tellSessionOnly(at, FULL_NOTICE);
        }
      } catch (error) {
        // A bug signal (a value outside its bounds), not an answer: no rule, the call the person allowed proceeds.
        say("always_rule_not_saved", { sessionId: at.row.id, err: error });
        tellSessionOnly(at, NOT_SAVED_NOTICE);
      }
    },
    stop: unlisten,
  };
}
