import { fileURLToPath } from "node:url";
import type { MigrationSource } from "../../kernel/db/migrate.ts";

export { pushReadiness } from "../../kernel/push-readiness.ts";
export { pushRpc, type PushRpc } from "./rpc.ts";
export * from "./service.ts";
export * from "./transport/index.ts";
export * from "./delivery/index.ts";

export const PUSH_MIGRATIONS: MigrationSource = {
  module: "push",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};
