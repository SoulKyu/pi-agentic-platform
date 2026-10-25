import { fileURLToPath } from "node:url";
import type { MigrationSource } from "../../kernel/db/migrate.ts";

export { createProviderKinds } from "./auth-kinds.ts";
export { createProviderGate, type ProviderGate } from "./provider-gate.ts";
export { createProviderSharing } from "./provider-sharing.ts";
export { createDeleteCascade } from "./delete.ts";
export { createDisabling } from "./disable.ts";
export { usersAdminRpc, type UsersAdminRpc } from "./rpc.ts";
export { createUsersService } from "./service.ts";
export { createProvidersAdmin, providersRpc, type ProvidersRpc } from "./providers-admin.ts";

export const USERS_MIGRATIONS: MigrationSource = {
  module: "users",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};
