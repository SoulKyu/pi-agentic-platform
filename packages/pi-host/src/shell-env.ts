import { isVaultName, unattendedEnv, type EnvSource } from "@pap/contracts";

/**
 * The environment an agent's VM shell gets from the vault (ADR 0048 and 0081, C §2.5 "an allowlist plus the agent's secrets
 * vault"): M9's unattended allowlist over the worker's environment (never the worker's own, which holds the relay key),
 * then the vault. Vault names cannot be HOME, PATH or any hijack name (`isVaultName`), so `set`'s order never matters.
 * The shell itself pins PATH, HOME, LANG and TERM after this (`vm-shell/ops.ts`).
 */
export function shellEnv(base: EnvSource, vault: Readonly<Record<string, string>>): Record<string, string> {
  // The schema already refuses these names; this keeps one that got here anyway out of the shell's environment (W5-R17).
  const allowed = Object.fromEntries(Object.entries(vault).filter(([name]) => isVaultName(name)));
  return unattendedEnv(base, { keep: [], set: allowed });
}

export interface ShellEnvironment {
  /** The environment of the next command (a copy: a caller cannot widen the one after it). The one-use value the command names rides on top (`withOnceSecrets`). */
  envFor(command: string): Readonly<Record<string, string>>;
  /** A `vault_update`: takes effect at the next command, never in one that runs. */
  setVault(vault: Readonly<Record<string, string>>): void;
}

/** Built from a snapshot of the worker's environment taken now, at start, and rebuilt on each vault update (M11R24). */
export function createShellEnvironment(
  base: EnvSource,
  vault: Readonly<Record<string, string>>,
): ShellEnvironment {
  const snapshot: EnvSource = { ...base };
  let env = shellEnv(snapshot, vault);
  return {
    envFor: () => ({ ...env }),
    setVault: (next) => {
      env = shellEnv(snapshot, next);
    },
  };
}
