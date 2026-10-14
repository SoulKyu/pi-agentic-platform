import {
  AlwaysRule,
  MAX_ALWAYS_RULES,
  type Notice,
  type PolicyRules,
  PrefixRule,
  SERVER_CODES,
  ToolRule,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { AlwaysInput, PolicyPort } from "../policy/index.ts";
import type { ApprovedAnswer } from "./dialogs.ts";
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
// The English text and its stable code (R128): the web shows the text in its own language by the code.
export const FULL_NOTICE: Pick<Notice, "text" | "code" | "params"> = {
  text: `This project already has ${MAX_ALWAYS_RULES} always-allowed calls: this one is allowed until this project's rules change.`,
  code: SERVER_CODES.rulesFull,
  params: { max: String(MAX_ALWAYS_RULES) },
};
export const NOT_SAVED_NOTICE: Pick<Notice, "text" | "code" | "params"> = {
  text: "This call is allowed until this project's rules change: its always rule could not be saved.",
  code: SERVER_CODES.rulesNotSaved,
};
const LOG_EVERY_MS = 60_000;

interface Launched {
  readonly row: SessionRow;
  readonly scope: string;
  noticeAt: number | null;
  /** The worker has said `ready`. Until then a change only marks `dirty`: one update goes out after `ready`. */
  ready: boolean;
  /** The rules the worker holds are older than the project's. */
  dirty: boolean;
}

/** The rules as they are, or null when there are more than the policy module keeps or they come to more than `maxBytes` of JSON. */
export function fitRules<T>(rules: T[], maxBytes = MAX_POLICY_BYTES): T[] | null {
  return rules.length <= MAX_ALWAYS_RULES && sizeOf(rules) <= maxBytes ? rules : null;
}

export interface GrantLinkDeps {
  readonly policy: PolicyPort;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The workers that are up and the ones still starting: a rule change reaches both (ADR 0001, M2R75). */
  sessions(): Iterable<LiveSession>;
  /** The whole rules of a session's worker (mode, lists, guard, taint, "always" rules): the policy link composes them. */
  compose(row: SessionRow, scope: string): PolicyRules;
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
  function alwaysFor(row: SessionRow, scope: string): AlwaysRule[] {
    const stored: AlwaysRule[] = deps.policy.rulesFor(row.ownerId, scope);
    const rules = stored.filter((rule) => AlwaysRule.safeParse(rule).success);
    if (rules.length !== stored.length) {
      say("policy_rule_invalid", { sessionId: row.id, skipped: stored.length - rules.length });
    }
    const fitted = fitRules(rules);
    if (!fitted) say("policy_rules_too_large", { sessionId: row.id, count: rules.length });
    return fitted ?? [];
  }

  // The prefix and tool rules the same way. The policy module counts every kind into one cap, so the three lists
  // together stay under it; each is checked on its own against the schema and the byte limit.
  function patternsFor(row: SessionRow, scope: string): Pick<PolicyRules, "alwaysPrefixes" | "alwaysTools"> {
    const kept = <T>(
      stored: T[],
      schema: { safeParse(value: unknown): { success: boolean } },
      what: string,
    ): T[] => {
      const rules = stored.filter((rule) => schema.safeParse(rule).success);
      if (rules.length !== stored.length) {
        say("policy_rule_invalid", { sessionId: row.id, skipped: stored.length - rules.length, what });
      }
      const fitted = fitRules(rules);
      if (!fitted) say("policy_rules_too_large", { sessionId: row.id, count: rules.length, what });
      return fitted ?? [];
    };
    return {
      alwaysPrefixes: kept(deps.policy.prefixesFor(row.ownerId, scope), PrefixRule, "prefix"),
      alwaysTools: kept(deps.policy.toolsFor(row.ownerId, scope), ToolRule, "tool"),
    };
  }

  // A worker that cannot be told keeps a rule that may be revoked: it is stopped, and the next prompt starts one with the current rules.
  function flush(session: LiveSession, at: Launched): void {
    // A worker being released is not told: it drops what it is sent, and the next one starts with the current rules.
    if (!at.dirty || session.status() === "cold" || session.stopping()) return;
    at.dirty = false;
    let sent = false;
    try {
      sent = session.send({ type: "policy_update", rules: deps.compose(at.row, at.scope) });
    } catch (error) {
      say("policy_update_failed", { sessionId: at.row.id, err: error });
    }
    if (sent) return;
    say("policy_update_not_sent", { sessionId: at.row.id });
    session.stop().catch((error: unknown) => {
      deps.logger.warn("policy_update_stop_failed", { sessionId: at.row.id, err: error });
    });
  }

  // Every update carries the whole list. A live worker gets it at once, inside the call that changed the rules, so a
  // request handled after that call (the next frame of the same socket read included) reaches the worker after it,
  // whatever that request awaits or not (carry #30, M5R7). A worker still starting gets one update right after `ready`
  // (it holds at most 128 records before then).
  function markDirty(session: LiveSession, at: Launched): void {
    at.dirty = true;
    if (at.ready) flush(session, at);
  }

  function pushAt(matches: (at: Launched) => boolean): void {
    for (const session of [...deps.sessions()]) {
      const at = launched.get(session);
      if (at && matches(at)) markDirty(session, at);
    }
  }

  const unlisten = deps.policy.onChange((ownerId, scope) =>
    pushAt((at) => at.row.ownerId === ownerId && at.scope === scope),
  );

  function tellSessionOnly(session: LiveSession, at: Launched, notice: typeof FULL_NOTICE): void {
    const now = deps.clock.now();
    if (at.noticeAt !== null && now - at.noticeAt < GRANT_NOTICE_EVERY_MS) return;
    at.noticeAt = now;
    session.notice({ level: "warning", ...notice });
  }

  return {
    scopeOf: (cwd: string): string => deps.policy.scopeOf(cwd),
    alwaysFor,
    patternsFor,
    /** Sends the whole rules to every tracked worker whose session matches, at once (one still starting gets them after `ready`). */
    pushWhere: (matches: (row: SessionRow) => boolean): void => pushAt((at) => matches(at.row)),
    /** The sessions of the workers tracked now (up or starting) whose row matches. */
    rowsWhere(matches: (row: SessionRow) => boolean): SessionRow[] {
      const rows: SessionRow[] = [];
      for (const session of deps.sessions()) {
        const at = launched.get(session);
        if (at && matches(at.row)) rows.push(at.row);
      }
      return rows;
    },
    /** Called right after the session's worker was started, before anything can await. */
    track(session: LiveSession, row: SessionRow, scope: string): void {
      const at: Launched = { row, scope, noticeAt: null, ready: false, dirty: false };
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
    answered(session: LiveSession, approved: ApprovedAnswer | null): void {
      if (approved?.answer !== "always") return;
      const at = launched.get(session);
      if (!at) {
        say("always_rule_not_saved", { reason: "session_not_tracked" });
        return;
      }
      try {
        const added = deps.policy.addAlways(alwaysInput(approved, at.row.ownerId, at.scope));
        if (added === "full") {
          tellSessionOnly(session, at, FULL_NOTICE);
        }
      } catch (error) {
        // A bug signal (a value outside its bounds), not an answer: no rule, the call the person allowed proceeds.
        say("always_rule_not_saved", { sessionId: at.row.id, err: error });
        tellSessionOnly(session, at, NOT_SAVED_NOTICE);
      }
    },
    stop: unlisten,
  };
}

export type GrantLink = ReturnType<typeof createGrantLink>;

/**
 * The rule an "always" answer asks for. A prefix or a tool rule is built from what the worker's request offered and the
 * daemon stored beside the dialog, never from the client's frame (M7R24); a scope that was not offered is a bug (the
 * answer path refuses it first) and throws, so no rule is made.
 */
function alwaysInput(approved: ApprovedAnswer, ownerId: string, scope: string): AlwaysInput {
  const { grant } = approved;
  const base = { ownerId, scope, tool: grant.tool, label: grant.label };
  if (approved.scope === "prefix" && grant.alwaysScopes?.prefix)
    return { ...base, kind: "prefix", prefix: grant.alwaysScopes.prefix };
  if (approved.scope === "tool" && grant.alwaysScopes?.toolSource)
    return { ...base, kind: "tool", source: grant.alwaysScopes.toolSource };
  if (approved.scope !== "exact") throw new Error("always scope not offered");
  return { ...base, kind: "exact", key: grant.key };
}
