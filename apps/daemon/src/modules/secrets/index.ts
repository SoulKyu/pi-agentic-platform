import { join } from "node:path";

export { createOnceStore } from "./refs.ts";
export { loadRefSalt } from "./ref-salt.ts";
export { createSecretRequests } from "./requests.ts";
export { type SecretRequestsRpc, type SecretsRpc, secretRequestsRpc, secretsRpc } from "./rpc.ts";
export { createSecrets } from "./service.ts";
export { createVaultStore, type VaultStore } from "./vault-store.ts";

/** `$PAP_HOME/secrets/vault`: the key and the per-owner scope files (M11R83). */
export const vaultRootOf = (papHome: string): string => join(papHome, "secrets", "vault");
