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
  // The network switch is the agent's (AVM2-E11): either value is a VM's.
  if (rules.data.sandbox?.required !== true) throw new PapError("internal");
  return rules.data;
}

/**
 * What a worker in a VM is told at `init` (RT-06, R17): the host record translated to the VM's paths. Nothing of the
 * host stays (no `testProviderScript`; `knowledge` is the VM's own, for a thread or a project box only); the vault and the one-use values do travel (ADR 0081).
 * `papHome` is a folder no VM has, so every host rule keyed on pap's home matches nothing (T11b replaces the ones a VM needs).
 * The record carries the relay key: it is never logged.
 */
export function vmInitOf(init: InitRecord, vm: VmInit, mirrorFile: string | null): InitRecord {
  const { layout } = vm;
  if (mirrorFile !== null && !SessionFileName.safeParse(mirrorFile).success)
    throw new PapError("bad_request");
  const rules = vmRulesOf(init.policy, layout.root);
  // The box and the rules agree: a project layout takes the project profile with the project folder as its own, and no other does.
  if (
    (layout.project !== undefined) !== (rules.profile === "project") ||
    (layout.project !== undefined && rules.agentHome !== layout.project)
  )
    throw new PapError("bad_request");
  const kept: InitRecord = {
    ...init,
    // A project box's sessions work in the project folder (their own folder, `agentHome`); an agent's in its home.
    cwd: layout.project ?? layout.home,
    agentDir: layout.piAgentDir,
    papHome: `${layout.pi}/pap`,
    policy: rules,
    vm,
  };
  delete kept.knowledge;
  // A thread's bundle is the VM's own folder; a task (isolated, scratch set) has none, whatever the host composed. A project
  // box always names `<project>/knowledge`, the host reads nothing of it: the worker decides whether it exists (task A4).
  if (rules.profile !== "isolated-task" && rules.agentScratch === null)
    kept.knowledge = { path: layout.knowledge };
  delete kept.testProviderScript;
  delete kept.sessionFile;
  if (mirrorFile !== null) kept.sessionFile = `${layout.sessions}/${mirrorFile}`;
  return kept;
}
