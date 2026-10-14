import {
  type AlwaysRule,
  type Caller,
  GrantKey,
  MAX_ALWAYS_RULES,
  methods,
  PapError,
  type PrefixRule,
  type ToolRule,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import {
  type PatternRule,
  patternKey,
  patternText,
  readPrefix,
  readTool,
  validPattern,
} from "./pattern-rules.ts";
import { projectScopeOf } from "./project-scope.ts";
import type { SessionPolicyPort } from "./session-service.ts";
import type { PolicyStore, RuleRow } from "./store.ts";

/** One "always" rule to keep: the exact call (`key`), a command prefix of bash, or a whole tool with its source. */
export type AlwaysInput = {
  readonly ownerId: string;
  readonly scope: string;
  readonly tool: string;
  readonly label: string;
} & (
  | { readonly kind?: "exact"; readonly key: string }
  | { readonly kind: "prefix"; readonly prefix: readonly string[] }
  | { readonly kind: "tool"; readonly source: ToolRule["source"] }
);

export interface PolicyPort extends SessionPolicyPort {
  /** The project a session's cwd belongs to: its git root, or the cwd outside git (owner R2-5). */
  scopeOf(cwd: string): string;
  /** The exact-call rules of a project. */
  rulesFor(ownerId: string, scope: string): AlwaysRule[];
  /** The prefix rules of a project; a stored row that no longer parses is skipped with one warning (never sent on). */
  prefixesFor(ownerId: string, scope: string): PrefixRule[];
  /** The whole-tool rules of a project, read the same way. */
  toolsFor(ownerId: string, scope: string): ToolRule[];
  /**
   * "added", "exists" or "full". A throw (`bad_request`: a tool, scope, key or pattern outside its bounds or holding
   * control characters; or a database error) is a bug signal, not an answer: the caller (Task 14b) fails closed,
   * creates no "always" rule and leaves the grant session-only. The label is never a reason to refuse: it is
   * sanitised. The 1 000-rule cap counts every kind (M7R25).
   */
  addAlways(input: AlwaysInput): "added" | "exists" | "full";
  /** Called after a rule was added or revoked. The returned function removes the listener. */
  onChange(listener: (ownerId: string, scope: string) => void): () => void;
}

export interface RuleView {
  readonly id: string;
  readonly scope: string;
  readonly tool: string;
  readonly label: string;
  readonly createdAt: number;
  readonly kind: "exact" | "prefix" | "tool";
  /** The words of a prefix rule. A row whose pattern no longer parses is listed without them, so it can be revoked. */
  readonly pattern?: string[];
}

const viewOf = (row: RuleRow): RuleView => {
  const words = row.kind === "prefix" ? readPrefix(row)?.prefix : undefined;
  return {
    id: row.id,
    scope: row.scope,
    tool: row.tool,
    label: row.label,
    createdAt: row.createdAt,
    kind: row.kind,
    ...(words ? { pattern: words } : {}),
  };
};

const MAX_LABEL = 4096;
const MAX_TOOL = 256;
const MAX_SCOPE = 4096;
// C0 controls, NUL included (written as code points: a control character in a regular expression is refused by lint).
const isC0 = (char: string): boolean => (char.codePointAt(0) ?? 0x20) < 0x20;

/** A tool or scope the contract carries and a text column keeps whole: 1..max characters, no control character. */
const plain = (text: string, max: number): boolean =>
  text.length >= 1 && text.length <= max && ![...text].some(isC0);

/** What the card showed, as stored: controls (NUL included, except tab and newline) become U+FFFD, then cut without splitting a pair. */
function cleanLabel(label: string): string {
  const cut = [...label.slice(0, MAX_LABEL)]
    .map((char) => (isC0(char) && char !== "\t" && char !== "\n" ? "\uFFFD" : char))
    .join("");
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const ruleSchema = methods["policy.listRules"].result.shape.rules.element;

/** The newest rules whose response stays under `PAGE_BYTES` JSON bytes; the oldest go first. */
function fitRules(newestFirst: readonly RuleView[]): { rules: RuleView[]; truncated: boolean } {
  let used = sizeOf({ rules: [], truncated: true });
  const rules: RuleView[] = [];
  for (const rule of newestFirst) {
    const size = sizeOf(rule) + 1;
    if (used + size > PAGE_BYTES) return { rules, truncated: true };
    used += size;
    rules.push(rule);
  }
  return { rules, truncated: false };
}

export function createPolicyService(deps: {
  store: PolicyStore;
  clock: Clock;
  logger: Logger;
  newId(): string;
  readonly audit: Pick<AuditPort, "append">;
}) {
  const listeners = new Set<(ownerId: string, scope: string) => void>();
  // A failing listener (a worker that went away) must not stop the others nor fail the answer that caused the change.
  const changed = (ownerId: string, scope: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, scope);
      } catch (error) {
        deps.logger.warn("policy_listener_failed", { err: error });
      }
    }
  };
  /** The newest rules (one more than the cap is read, to know whether any were left out). */
  const newest = (ownerId: string, cwd?: string): { rules: RuleView[]; more: boolean } => {
    const rows = deps.store.newest(
      ownerId,
      cwd === undefined ? null : projectScopeOf(cwd),
      MAX_ALWAYS_RULES + 1,
    );
    return { rules: rows.slice(0, MAX_ALWAYS_RULES).map(viewOf), more: rows.length > MAX_ALWAYS_RULES };
  };
  const list = (ownerId: string, cwd?: string): RuleView[] => newest(ownerId, cwd).rules;
  /** The rows that still parse as rules; the ones that do not are left out, with one warning for the read (M7 Task 2b). */
  function readable<T>(
    rows: readonly RuleRow[],
    kind: "prefix" | "tool",
    read: (row: RuleRow) => T | null,
  ): T[] {
    const rules = rows.flatMap((row) => read(row) ?? []);
    if (rules.length < rows.length)
      deps.logger.warn("policy_rule_unreadable", { kind, skipped: rows.length - rules.length });
    return rules;
  }
  return {
    rulesFor: (ownerId: string, scope: string): AlwaysRule[] =>
      deps.store
        .forScope(ownerId, scope, "exact", MAX_ALWAYS_RULES)
        .map((row) => ({ tool: row.tool, key: row.grantKey })),
    prefixesFor: (ownerId: string, scope: string): PrefixRule[] =>
      readable(deps.store.forScope(ownerId, scope, "prefix", MAX_ALWAYS_RULES), "prefix", readPrefix),
    toolsFor: (ownerId: string, scope: string): ToolRule[] =>
      readable(deps.store.forScope(ownerId, scope, "tool", MAX_ALWAYS_RULES), "tool", readTool),
    scopeOf: projectScopeOf,
    addAlways(input: AlwaysInput): "added" | "exists" | "full" {
      const pattern: PatternRule | null =
        input.kind === "prefix"
          ? { kind: "prefix", prefix: input.prefix }
          : input.kind === "tool"
            ? { kind: "tool", source: input.source }
            : null;
      const kind = input.kind ?? "exact";
      if (kind !== "exact" && pattern === null) throw new PapError("bad_request");
      // Exact: the worker's grant key. The other kinds: the daemon's own key over the validated pattern (M7R23).
      const key = pattern === null ? ("key" in input ? input.key : "") : patternKey(input.tool, pattern);
      if (
        !plain(input.tool, MAX_TOOL) ||
        !plain(input.scope, MAX_SCOPE) ||
        !GrantKey.safeParse(key).success ||
        (pattern === null ? kind !== "exact" : !validPattern(input.tool, pattern))
      )
        throw new PapError("bad_request");
      // Count and insert are one transaction, so the cap holds even if an await is ever added between them (the
      // database has a single writer today). "Exists" comes before "full": answering Always again on a rule that is
      // there is not a new rule (M2-RT-24).
      const outcome = deps.store.transaction((): "added" | "exists" | "full" => {
        if (deps.store.exists(input.ownerId, input.scope, input.tool, key)) return "exists";
        if (deps.store.count(input.ownerId, input.scope) >= MAX_ALWAYS_RULES) return "full";
        const row: RuleRow = {
          id: deps.newId(),
          ownerId: input.ownerId,
          scope: input.scope,
          tool: input.tool,
          grantKey: key,
          label: cleanLabel(input.label),
          createdAt: deps.clock.now(),
          kind,
          pattern: pattern === null ? null : patternText(pattern),
        };
        return deps.store.insert(row) ? "added" : "exists";
      });
      if (outcome === "full") deps.logger.warn("approval_rules_full", { max: MAX_ALWAYS_RULES });
      if (outcome !== "added") return outcome;
      changed(input.ownerId, input.scope);
      return "added";
    },
    /** The caller's rules, newest first: all of them, or those of the project `cwd` belongs to. */
    list,
    /** `list`, cut to what fits one frame (oldest dropped first, `truncated` says so). */
    listPage(ownerId: string, cwd?: string) {
      const { rules, more } = newest(ownerId, cwd);
      // Defence in depth: a stored row the result schema refuses must not fail the whole list (and with it every
      // revocation). It is left out, counted into `truncated`, and logged once per call.
      const valid = rules.filter((rule) => ruleSchema.safeParse(rule).success);
      if (valid.length < rules.length)
        deps.logger.warn("policy_rule_invalid", { skipped: rules.length - valid.length });
      const fitted = fitRules(valid);
      return { rules: fitted.rules, truncated: fitted.truncated || more || valid.length < rules.length };
    },
    revoke(caller: Caller, ruleId: string): void {
      const ownerId = caller.userId;
      // Another owner's rule is `not_found`, the same as an unknown id: existence does not leak.
      const row = deps.store.get(ownerId, ruleId);
      if (!row || !deps.store.remove(ownerId, ruleId)) throw new PapError("not_found");
      // M5R45, M5R47: the trail records who revoked what; a failing audit never undoes the revocation.
      try {
        deps.audit.append({
          ownerId,
          actor: caller.kind === "token" ? "token" : "user",
          ...(caller.credentialId ? { actorId: caller.credentialId } : {}),
          kind: "policy",
          reason: "rule_revoked",
          detail: { ruleId, tool: row.tool },
        });
      } catch (error) {
        deps.logger.error("audit_append_failed", { reason: "rule_revoked", err: error });
      }
      changed(ownerId, row.scope);
    },
    onChange(listener: (ownerId: string, scope: string) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type PolicyService = ReturnType<typeof createPolicyService>;
