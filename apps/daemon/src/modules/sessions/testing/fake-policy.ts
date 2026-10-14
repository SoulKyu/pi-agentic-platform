import {
  type AlwaysRule,
  type ApprovalMode,
  type DaemonToWorker,
  DEFAULT_POLICY_SETTINGS,
  type InitRecord,
  NO_TAINT,
  PolicyRules,
  type PolicySettings,
  type PrefixRule,
  type TaintState,
  type ToolRule,
} from "@pap/contracts";
import type { FakeWorker } from "../../../kernel/testing/fake-worker.ts";
import type { AlwaysInput, PolicyPort } from "../../policy/index.ts";

export interface FakePolicyOptions {
  /** `addAlways` answers "full". */
  full?: boolean;
  /** `addAlways` throws, as the real one does for a bug (a tool, scope or key outside its bounds). */
  throws?: boolean;
}

export type AddedRule = AlwaysInput;

const slot = (ownerId: string, scope: string) => `${ownerId}\u0000${scope}`;

/** A `PolicyPort` for the sessions tests: the identity for `scopeOf`, rules kept per owner and project, listeners told on every change. */
export function fakePolicyPort(options: FakePolicyOptions = {}) {
  const rules = new Map<string, AlwaysRule[]>();
  const prefixes = new Map<string, PrefixRule[]>();
  const tools = new Map<string, ToolRule[]>();
  const added: AddedRule[] = [];
  const listeners = new Set<(ownerId: string, scope: string) => void>();
  let failReads = false;
  let failSettings = false;
  // What the policy module keeps (Task 12a), in memory: a session's own mode, its taint, an owner's settings.
  const modes = new Map<string, ApprovalMode>();
  const taints = new Map<string, TaintState>();
  const settingsOf = new Map<string, PolicySettings>();
  const sessionListeners = new Set<(ownerId: string, sessionId: string) => void>();
  const settingsListeners = new Set<(ownerId: string) => void>();
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
    prefixesFor(ownerId, scope) {
      if (failReads) throw new Error("prefixesFor failed");
      return [...(prefixes.get(slot(ownerId, scope)) ?? [])];
    },
    toolsFor(ownerId, scope) {
      if (failReads) throw new Error("toolsFor failed");
      return [...(tools.get(slot(ownerId, scope)) ?? [])];
    },
    addAlways(input) {
      if (options.throws) throw new Error("addAlways failed");
      if (options.full) return "full";
      const at = slot(input.ownerId, input.scope);
      if (input.kind === "prefix") {
        const list = prefixes.get(at) ?? [];
        if (list.some((rule) => rule.prefix.join(" ") === input.prefix.join(" "))) return "exists";
        prefixes.set(at, [...list, { prefix: [...input.prefix] }]);
      } else if (input.kind === "tool") {
        const list = tools.get(at) ?? [];
        if (list.some((rule) => rule.tool === input.tool && rule.source === input.source)) return "exists";
        tools.set(at, [...list, { tool: input.tool, source: input.source }]);
      } else {
        const list = of(input.ownerId, input.scope);
        if (list.some((rule) => rule.tool === input.tool && rule.key === input.key)) return "exists";
        list.push({ tool: input.tool, key: input.key });
      }
      added.push(input);
      tell(input.ownerId, input.scope);
      return "added";
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    sessionPolicy(ownerId, sessionId) {
      const own = modes.get(sessionId);
      return {
        mode: own ?? (settingsOf.get(ownerId) ?? DEFAULT_POLICY_SETTINGS).defaultMode,
        explicit: own !== undefined,
        taint: taints.get(sessionId) ?? NO_TAINT,
      };
    },
    settings(ownerId) {
      if (failSettings) throw new Error("settings failed");
      return settingsOf.get(ownerId) ?? DEFAULT_POLICY_SETTINGS;
    },
    markTainted(ownerId, sessionId, observedEpoch) {
      const current = taints.get(sessionId) ?? NO_TAINT;
      if (current.tainted || (observedEpoch !== undefined && current.epoch > observedEpoch)) return false;
      taints.set(sessionId, { tainted: true, epoch: current.epoch });
      for (const listener of [...sessionListeners]) listener(ownerId, sessionId);
      return true;
    },
    inherit(_ownerId, sourceId, targetId) {
      const mode = modes.get(sourceId);
      if (mode !== undefined) modes.set(targetId, mode);
      const taint = taints.get(sourceId);
      const held = taints.get(targetId);
      if (taint)
        taints.set(targetId, { tainted: (held?.tainted ?? false) || taint.tainted, epoch: held?.epoch ?? 0 });
    },
    onSessionChange(listener) {
      sessionListeners.add(listener);
      return () => void sessionListeners.delete(listener);
    },
    onSettingsChange(listener) {
      settingsListeners.add(listener);
      return () => void settingsListeners.delete(listener);
    },
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
    /** What the policy module does when a prefix rule is revoked. */
    revokePrefix(ownerId: string, scope: string, prefix: readonly string[]) {
      const at = slot(ownerId, scope);
      prefixes.set(
        at,
        (prefixes.get(at) ?? []).filter((rule) => rule.prefix.join(" ") !== prefix.join(" ")),
      );
      tell(ownerId, scope);
    },
    /** Sets the rules of an owner's project without telling anyone (to set up a worker's start). */
    seed(ownerId: string, scope: string, next: AlwaysRule[]) {
      rules.set(slot(ownerId, scope), [...next]);
    },
    /** What the policy module does when a session's mode is set: it is kept, the listeners are told. */
    setMode(ownerId: string, sessionId: string, mode: ApprovalMode) {
      modes.set(sessionId, mode);
      for (const listener of [...sessionListeners]) listener(ownerId, sessionId);
    },
    /** What the policy module does when the owner clears the taint: lowered, the epoch up by one, the listeners told. */
    clearTaint(ownerId: string, sessionId: string) {
      const current = taints.get(sessionId) ?? NO_TAINT;
      taints.set(sessionId, { tainted: false, epoch: current.epoch + 1 });
      for (const listener of [...sessionListeners]) listener(ownerId, sessionId);
    },
    taintOf: (sessionId: string): TaintState => taints.get(sessionId) ?? NO_TAINT,
    /** What the policy module does when the owner saves settings: they are kept, the listeners are told. */
    setSettings(ownerId: string, value: PolicySettings) {
      settingsOf.set(ownerId, value);
      for (const listener of [...settingsListeners]) listener(ownerId);
    },
    /** `settings` throws from now on (`sessionPolicy` still answers). */
    failSettings() {
      failSettings = true;
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

/** The `init` record the i-th spawned worker received (the bed's `spawned`). */
export const initRecordOf = (worker: FakeWorker | undefined): InitRecord =>
  worker?.sent.find((record) => record.type === "init") as InitRecord;

/** The `policy_update` record the grant link sends for these rules (interactive profile, default mode). */
export const pushedRules = (alwaysAllow: AlwaysRule[]) => ({
  type: "policy_update",
  rules: PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow }),
});

/** The `policy_update` records a fake worker was sent, in order. */
export const policyUpdatesOf = (worker: FakeWorker | undefined): DaemonToWorker[] =>
  worker?.sent.filter((record) => record.type === "policy_update") ?? [];
