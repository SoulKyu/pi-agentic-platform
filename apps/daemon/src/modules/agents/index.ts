import { fileURLToPath } from "node:url";
import type { MigrationSource } from "../../kernel/db/migrate.ts";

export const AGENTS_MIGRATIONS: MigrationSource = {
  module: "agents",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export { agentsRpc, type AgentsRpc } from "./rpc.ts";
export { type AgentsPackagesRpc, agentsPackagesRpc, createAgentPackages } from "./packages.ts";
export { type AgentsPort, createAgents } from "./service.ts";
export { type AgentsOwnerCascade, createAgentsOwnerCascade } from "./owner-cascade.ts";
export { createAgentsStream } from "./stream.ts";
export { createRequestViews } from "./requests-store.ts";
export { createThreadLink } from "./thread-link.ts";
export { createAgentGuard, createThreads } from "./threads.ts";
export { createUnread } from "./unread.ts";
export { createAgentReads } from "./status.ts";
export { createQueueTask } from "./queue.ts";
export { createAgentSafety } from "./safety.ts";
export { type AgentEvents, createAgentEvents, SUMMARY_CHARS } from "./events.ts";
export {
  createDelegate,
  createDelegationBack,
  DELEGATION_ASK_CHARS,
  type DelegationBack,
} from "./ops-delegate.ts";
export { createRemind } from "./ops-remind.ts";
export type { ScratchPort } from "./scratch-port.ts";
export { cleanText, createRequests, type RequestItems, type Requests } from "./requests.ts";
export { createNotify } from "./ops-notify.ts";
export { createApprove } from "./ops-approve.ts";
export { createNetworkRequest } from "./ops-network.ts";
export { createInboxLink } from "./inbox-link.ts";
export { createCrashPause } from "./vm-crash.ts";
export type { AgentLinks, AgentVmLink } from "./links.ts";
export { removeTree } from "./homes.ts";
