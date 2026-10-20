import type { Logger } from "./kernel/logger.ts";
import {
  createOwnerSecrets,
  loadClaudeTokenStrict,
  type OwnerSecretsCollector,
  readPiAuth,
  secretsDirOf,
} from "./modules/agent-vm/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";

/**
 * T15b: the collector of the owner's secrets (auth.json through Pi's storage, every value of the vault, the Claude token).
 * It keeps nothing: the image build and the relay's stderr redactor each call it when they need the values. The vault is a
 * second reader of the same files, without the start-up sweep of temporary files (that belongs to the daemon's own store). The
 * Claude token is read strictly (`$PAP_HOME/secrets/claude-token`): only "no file" is no token.
 */
export function composeOwnerSecrets(core: {
  readonly home: string;
  readonly piAgentDir: string;
  readonly logger: Logger;
}): OwnerSecretsCollector {
  const vault = createVaultStore(vaultRootOf(core.home), { sweep: false });
  return createOwnerSecrets({
    logger: core.logger,
    auth: () => readPiAuth(core.piAgentDir),
    vault: () => vault.everyValue(),
    claudeToken: () => loadClaudeTokenStrict(secretsDirOf(core.home)),
  });
}
