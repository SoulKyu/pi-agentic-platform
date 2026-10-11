import type { AlwaysRule } from "@pap/contracts";
import type { PolicyPort } from "../../policy/index.ts";

export interface FakePolicyOptions {
  /** `addAlways` answers "full". */
  full?: boolean;
  /** `addAlways` throws, as the real one does for a bug (a tool, scope or key outside its bounds). */
  throws?: boolean;
}

export interface AddedRule {
  ownerId: string;
  scope: string;
  tool: string;
  key: string;
  label: string;
}

/** A `PolicyPort` for the sessions tests: the identity for `scopeOf`, rules kept in memory, listeners told on every change. */
export function fakePolicyPort(initial: AlwaysRule[] = [], options: FakePolicyOptions = {}) {
  const rules: AlwaysRule[] = [...initial];
  const added: AddedRule[] = [];
  const listeners = new Set<(ownerId: string, scope: string) => void>();
  const tell = (ownerId: string, scope: string) => {
    for (const listener of [...listeners]) listener(ownerId, scope);
  };
  const port: PolicyPort = {
    scopeOf: (cwd) => cwd,
    rulesFor: () => [...rules],
    addAlways(input) {
      if (options.throws) throw new Error("addAlways failed");
      if (options.full) return "full";
      if (rules.some((rule) => rule.tool === input.tool && rule.key === input.key)) return "exists";
      added.push(input);
      rules.push({ tool: input.tool, key: input.key });
      tell(input.ownerId, input.scope);
      return "added";
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    ...port,
    added,
    listenerCount: () => listeners.size,
    /** What the policy module does when a rule is revoked: the rule is gone, the listeners are told. */
    revoke(ownerId: string, scope: string, key: string) {
      const at = rules.findIndex((rule) => rule.key === key);
      if (at >= 0) rules.splice(at, 1);
      tell(ownerId, scope);
    },
    /** Replaces the rules without telling anyone (to set up a worker's start). */
    setRules(next: AlwaysRule[]) {
      rules.splice(0, rules.length, ...next);
    },
  };
}
