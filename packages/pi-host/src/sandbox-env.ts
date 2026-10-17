import { EGRESS_ENV, isVaultName, unattendedEnv, type EnvSource } from "@pap/contracts";

/**
 * The whole environment of an agent's sandboxed command (ADR 0048, C §2.5 "an allowlist plus the agent's secrets vault"):
 * M9's unattended allowlist over the worker's environment (never the worker's own, which holds provider keys), the
 * variables of pap's egress proxy only when the sandbox has network (the owner's own are never kept: decision 90), then the
 * vault, then the sandbox's own HOME and TMPDIR, which win. Vault
 * names cannot be HOME, PATH, TMPDIR or any hijack name (`isVaultName`, Task 13), so `set`'s order only matters for them.
 */
export function sandboxEnv(
  base: EnvSource,
  sandbox: { readonly home: string; readonly network: boolean },
  vault: Readonly<Record<string, string>>,
): Record<string, string> {
  // The schema already refuses these names; this keeps one that got here anyway out of bwrap's own environment (W5-R17).
  const allowed = Object.fromEntries(Object.entries(vault).filter(([name]) => isVaultName(name)));
  return unattendedEnv(base, {
    keep: [],
    set: { ...(sandbox.network ? EGRESS_ENV : {}), ...allowed, HOME: sandbox.home, TMPDIR: "/tmp" },
  });
}

export interface SandboxEnvironment {
  /** The environment of the next command (a copy: a caller cannot widen the one after it). Task 18 adds the one-use value the command names. */
  envFor(command: string): Readonly<Record<string, string>>;
  /** A `vault_update`: takes effect at the next command, never in one that runs. */
  setVault(vault: Readonly<Record<string, string>>): void;
}

/** Built from a snapshot of the worker's environment taken now, at start, and rebuilt on each vault update (M11R24). */
export function createSandboxEnvironment(
  base: EnvSource,
  sandbox: { readonly home: string; readonly network: boolean },
  vault: Readonly<Record<string, string>>,
): SandboxEnvironment {
  const snapshot: EnvSource = { ...base };
  let env = sandboxEnv(snapshot, sandbox, vault);
  return {
    envFor: () => ({ ...env }),
    setVault: (next) => {
      env = sandboxEnv(snapshot, sandbox, next);
    },
  };
}
