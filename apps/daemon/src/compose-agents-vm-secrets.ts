import { readdirSync } from "node:fs";
import type { Logger } from "./kernel/logger.ts";
import {
  createOwnerSecrets,
  type OwnerSecretsCollector,
  readPiAuth,
  secretsDirOf,
} from "./modules/agent-vm/index.ts";
import { githubAppSecretValues } from "./modules/github/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";

/** The users that keep a vault: one directory each under the vault root (none yet counts as one). */
function vaultOwners(root: string): number {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 1;
  }
}

/**
 * T15b, R13: the collector of the install's secrets. The image build (the shared Pi profile scan) gets auth.json through Pi's
 * storage, the owner's vault, the GitHub App's key and client secret and the box tokens in use: members cannot write the
 * profile, so their values could only raise a false positive. The relay's stderr redactor also masks every user's vault; a
 * damaged vault of another user is skipped with a fixed warning.
 * It keeps nothing: each call reads again. The vault is a second reader of the same files, without the start-up sweep of
 * temporary files (that belongs to the daemon's own store).
 */
export function composeOwnerSecrets(core: {
  readonly home: string;
  readonly piAgentDir: string;
  readonly logger: Logger;
  readonly githubLive?: () => readonly string[];
  /** The install's owner: nobody (null or absent) leaves the build with no vault values. */
  readonly ownerId?: () => string | null;
}): OwnerSecretsCollector {
  const vault = createVaultStore(vaultRootOf(core.home), { sweep: false });
  return createOwnerSecrets({
    logger: core.logger,
    users: () => vaultOwners(vaultRootOf(core.home)),
    auth: () => readPiAuth(core.piAgentDir),
    vault: () => {
      const owner = core.ownerId?.() ?? null;
      return owner === null ? [] : vault.valuesOf(owner);
    },
    redactVault: () => {
      const values: string[] = [];
      for (const user of vault.ownerIds()) {
        try {
          values.push(...vault.valuesOf(user));
        } catch {
          core.logger.warn("owner_secrets_user_vault_skipped", { source: "vault" });
        }
      }
      return values;
    },
    extra: () => [
      ...githubAppSecretValues(secretsDirOf(core.home), core.logger),
      ...(core.githubLive?.() ?? []),
    ],
  });
}
