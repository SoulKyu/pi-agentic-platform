import { type AlwaysRule, MAX_ALWAYS_RULES, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { projectScopeOf } from "./project-scope.ts";
import type { PolicyStore, RuleRow } from "./store.ts";

export interface PolicyPort {
  /** The project a session's cwd belongs to: its git root, or the cwd outside git (owner R2-5). */
  scopeOf(cwd: string): string;
  rulesFor(ownerId: string, scope: string): AlwaysRule[];
  addAlways(input: {
    ownerId: string;
    scope: string;
    tool: string;
    key: string;
    label: string;
  }): "added" | "exists" | "full";
  /** Called after a rule was added or revoked. The returned function removes the listener. */
  onChange(listener: (ownerId: string, scope: string) => void): () => void;
}

export interface RuleView {
  readonly id: string;
  readonly scope: string;
  readonly tool: string;
  readonly label: string;
  readonly createdAt: number;
}

const viewOf = (row: RuleRow): RuleView => ({
  id: row.id,
  scope: row.scope,
  tool: row.tool,
  label: row.label,
  createdAt: row.createdAt,
});

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
  const list = (ownerId: string, cwd?: string): RuleView[] =>
    (cwd === undefined
      ? deps.store.forOwner(ownerId, MAX_ALWAYS_RULES)
      : deps.store.forScope(ownerId, projectScopeOf(cwd), MAX_ALWAYS_RULES).toReversed()
    ).map(viewOf);
  return {
    rulesFor: (ownerId: string, scope: string): AlwaysRule[] =>
      deps.store
        .forScope(ownerId, scope, MAX_ALWAYS_RULES)
        .map((row) => ({ tool: row.tool, key: row.grantKey })),
    scopeOf: projectScopeOf,
    addAlways(input: {
      ownerId: string;
      scope: string;
      tool: string;
      key: string;
      label: string;
    }): "added" | "exists" | "full" {
      // Checks and insert run with no await between them: SQLite calls are synchronous here. "Exists" comes before
      // "full": answering Always again on a rule that is there is not a new rule (M2-RT-24).
      if (deps.store.exists(input.ownerId, input.scope, input.tool, input.key)) return "exists";
      if (deps.store.count(input.ownerId, input.scope) >= MAX_ALWAYS_RULES) {
        deps.logger.warn("approval_rules_full", { max: MAX_ALWAYS_RULES });
        return "full";
      }
      const row: RuleRow = {
        id: deps.newId(),
        ownerId: input.ownerId,
        scope: input.scope,
        tool: input.tool,
        grantKey: input.key,
        label: input.label.slice(0, 4096),
        createdAt: deps.clock.now(),
      };
      if (!deps.store.insert(row)) return "exists";
      changed(input.ownerId, input.scope);
      return "added";
    },
    /** The caller's rules, newest first: all of them, or those of the project `cwd` belongs to. */
    list,
    /** `list`, cut to what fits one frame (oldest dropped first, `truncated` says so). */
    listPage: (ownerId: string, cwd?: string) => fitRules(list(ownerId, cwd)),
    revoke(ownerId: string, ruleId: string): void {
      // Another owner's rule is `not_found`, the same as an unknown id: existence does not leak.
      const row = deps.store.get(ownerId, ruleId);
      if (!row || !deps.store.remove(ownerId, ruleId)) throw new PapError("not_found");
      changed(ownerId, row.scope);
    },
    onChange(listener: (ownerId: string, scope: string) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type PolicyService = ReturnType<typeof createPolicyService>;
