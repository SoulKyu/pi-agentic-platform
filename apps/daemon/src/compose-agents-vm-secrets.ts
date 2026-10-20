import type { Logger } from "./kernel/logger.ts";
import {
  type ClaudeTokenStore,
  createOwnerSecrets,
  type OwnerSecretsCollector,
  readPiAuth,
} from "./modules/agent-vm/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";

/**
 * T15b: the collector of the owner's secrets (auth.json through Pi's storage, every value of the vault, the Claude token).
 * It keeps nothing: the image build and the relay's stderr redactor each call it when they need the values. The vault is a
 * second reader of the same files, without the start-up sweep of temporary files (that belongs to the daemon's own store).
 */
export function composeOwnerSecrets(core: {
  readonly home: string;
  readonly piAgentDir: string;
  readonly logger: Logger;
  readonly claudeToken: Pick<ClaudeTokenStore, "load">;
}): OwnerSecretsCollector {
  const vault = createVaultStore(vaultRootOf(core.home), { sweep: false });
  return createOwnerSecrets({
    logger: core.logger,
    auth: () => readPiAuth(core.piAgentDir),
    vault: () => vault.everyValue(),
    claudeToken: () => core.claudeToken.load(),
  });
}
