import type { InitRecord, VmInit } from "@pap/contracts";

/**
 * What a worker in a VM is told at `init` (RT-06, R11, R17): the host record translated to the VM's paths. Nothing of the
 * host stays (no `sandbox`, whose folders are host folders; no `testProviderScript`), and no `vault`, `once` or `memory`.
 * `papHome` is a folder no VM has, so every host rule keyed on pap's home matches nothing (T11b replaces the ones a VM needs).
 * The record carries the relay key: it is never logged.
 */
export function vmInitOf(init: InitRecord, vm: VmInit, mirrorFile: string | null): InitRecord {
  const { layout } = vm;
  const kept: InitRecord = {
    ...init,
    cwd: layout.home,
    agentDir: layout.piAgentDir,
    papHome: `${layout.pi}/pap`,
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
