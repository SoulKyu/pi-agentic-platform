import { posix } from "node:path";
import { type InitRecord, PapError, PolicyRules, SessionFileName, type VmInit } from "@pap/contracts";

/** Normalised, so a `..` cannot step out of the root. */
const within = (path: string | null, root: string): boolean =>
  path === null || (posix.normalize(path) === path && (path === root || path.startsWith(`${root}/`)));

/**
 * The rules the init carries must already be the VM's (`vmRuleParts`): a folder outside the VM's root is a host path, and an
 * "always" grant was made for a host call. Either refuses the init: a host path in a VM breaks the box (RT-06).
 */
function vmRulesOf(policy: unknown, root: string): PolicyRules {
  const rules = PolicyRules.safeParse(policy);
  if (
    !rules.success ||
    !within(rules.data.agentHome, root) ||
    !within(rules.data.agentScratch, root) ||
    rules.data.alwaysAllow.length > 0 ||
    rules.data.alwaysPrefixes.length > 0 ||
    rules.data.alwaysTools.length > 0
  )
    throw new PapError("bad_request");
  // R15 (T8a): `vmRuleParts` always sets this; rules without it were not composed for a VM, whatever their folders say.
  if (rules.data.sandbox?.required !== true || rules.data.sandbox.network) throw new PapError("internal");
  return rules.data;
}

/**
 * What a worker in a VM is told at `init` (RT-06, R11, R17): the host record translated to the VM's paths. Nothing of the
 * host stays (no `sandbox`, whose folders are host folders; no `testProviderScript`), and no `vault`, `once` or `memory`.
 * `papHome` is a folder no VM has, so every host rule keyed on pap's home matches nothing (T11b replaces the ones a VM needs).
 * The record carries the relay key: it is never logged.
 */
export function vmInitOf(init: InitRecord, vm: VmInit, mirrorFile: string | null): InitRecord {
  const { layout } = vm;
  if (mirrorFile !== null && !SessionFileName.safeParse(mirrorFile).success)
    throw new PapError("bad_request");
  const kept: InitRecord = {
    ...init,
    cwd: layout.home,
    agentDir: layout.piAgentDir,
    papHome: `${layout.pi}/pap`,
    policy: vmRulesOf(init.policy, layout.root),
    vm,
  };
  delete kept.sandbox;
  delete kept.vault;
  delete kept.once;
  delete kept.memory;
  delete kept.testProviderScript;
  delete kept.sessionFile;
  if (mirrorFile !== null) kept.sessionFile = `${layout.sessions}/${mirrorFile}`;
  if (init.platform !== undefined)
    kept.platform = { ops: init.platform.ops.filter((op) => op !== "secret.request") };
  return kept;
}
