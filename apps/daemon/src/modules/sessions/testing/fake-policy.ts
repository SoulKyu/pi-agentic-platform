import {
  type AlwaysRule,
  DEFAULT_APPROVAL_MODE,
  type DaemonToWorker,
  DEFAULT_POLICY_SETTINGS,
  NO_TAINT,
  PolicyRules,
} from "@pap/contracts";
import type { FakeWorker } from "../../../kernel/testing/fake-worker.ts";
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

const slot = (ownerId: string, scope: string) => `${ownerId}\u0000${scope}`;

/** A `PolicyPort` for the sessions tests: the identity for `scopeOf`, rules kept per owner and project, listeners told on every change. */
export function fakePolicyPort(options: FakePolicyOptions = {}) {
  const rules = new Map<string, AlwaysRule[]>();
  const added: AddedRule[] = [];
  const listeners = new Set<(ownerId: string, scope: string) => void>();
  let failReads = false;
  const of = (ownerId: string, scope: string): AlwaysRule[] => {
    let list = rules.get(slot(ownerId, scope));
    if (!list) rules.set(slot(ownerId, scope), (list = []));
    return list;
  };
  const tell = (ownerId: string, scope: string) => {
    for (const listener of [...listeners]) listener(ownerId, scope);
  };
  const port: PolicyPort = {
    scopeOf: (cwd) => cwd,
    rulesFor(ownerId, scope) {
      if (failReads) throw new Error("rulesFor failed");
      return [...of(ownerId, scope)];
    },
    addAlways(input) {
      if (options.throws) throw new Error("addAlways failed");
      if (options.full) return "full";
      const list = of(input.ownerId, input.scope);
      if (list.some((rule) => rule.tool === input.tool && rule.key === input.key)) return "exists";
      added.push(input);
      list.push({ tool: input.tool, key: input.key });
      tell(input.ownerId, input.scope);
      return "added";
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // The session modes, the taint and the owner settings are inert here: the sessions tests of Tasks 12b-1 and 12b-2 extend them.
    sessionPolicy: () => ({ mode: DEFAULT_APPROVAL_MODE, explicit: false, taint: NO_TAINT }),
    settings: () => DEFAULT_POLICY_SETTINGS,
    markTainted: () => false,
    inherit: () => {},
    onSessionChange: () => () => {},
    onSettingsChange: () => () => {},
  };
  return {
    ...port,
    added,
    listenerCount: () => listeners.size,
    /** What the policy module does when a rule is revoked: the rule is gone, the listeners are told. */
    revoke(ownerId: string, scope: string, key: string) {
      const list = of(ownerId, scope);
      const at = list.findIndex((rule) => rule.key === key);
      if (at >= 0) list.splice(at, 1);
      tell(ownerId, scope);
    },
    /** Sets the rules of an owner's project without telling anyone (to set up a worker's start). */
    seed(ownerId: string, scope: string, next: AlwaysRule[]) {
      rules.set(slot(ownerId, scope), [...next]);
    },
    /** `rulesFor` throws from now on. */
    failReads() {
      failReads = true;
    },
  };
}

/** The i-th distinct rule: a tool named after `i` and a 64-hex key. */
export const testRule = (i: number): AlwaysRule => ({
  tool: `tool-${i}`,
  key: i.toString(16).padStart(64, "0"),
});

/** Adds the i-th test rule to an owner's project through the port, as an "always" answer would. */
export const addTestRule = (
  policy: ReturnType<typeof fakePolicyPort>,
  scope: string,
  i: number,
  ownerId = "u1",
): void => {
  policy.addAlways({ ownerId, scope, tool: testRule(i).tool, key: testRule(i).key, label: "x" });
};

/** The `policy_update` record the grant link sends for these rules (interactive profile, default mode). */
export const pushedRules = (alwaysAllow: AlwaysRule[]) => ({
  type: "policy_update",
  rules: PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow }),
});

/** The `policy_update` records a fake worker was sent, in order. */
export const policyUpdatesOf = (worker: FakeWorker | undefined): DaemonToWorker[] =>
  worker?.sent.filter((record) => record.type === "policy_update") ?? [];
