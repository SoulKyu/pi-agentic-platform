import { fileURLToPath } from "node:url";
import type { MigrationSource } from "../../kernel/db/migrate.ts";

export { inboxRpc, type InboxRpc } from "./rpc.ts";
export { createInbox, type Inbox, type InboxItemEvent } from "./service.ts";

export const INBOX_MIGRATIONS: MigrationSource = {
  module: "inbox",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};
