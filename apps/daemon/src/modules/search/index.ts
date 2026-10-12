import { join } from "node:path";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { indexBytes, openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { type SearchRpc, searchRpc } from "./rpc.ts";
import { createSearchClient, type SpawnThread } from "./search-client.ts";
import { createSearchService } from "./service.ts";

export interface SearchModule {
  readonly rpc: SearchRpc;
  stop(): Promise<void>;
}

export function createSearchModule(deps: {
  readonly home: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessions: SessionsScanPort;
  readonly spawn?: SpawnThread;
}): SearchModule {
  const logger = deps.logger.child({ module: "search" });
  const dbPath = join(deps.home, "search.db");
  const db = openSearchIndex(dbPath, logger);
  // No global cap: the size is said at boot and documented (owner Q14). A count that fails must not stop the boot: the
  // scanner meets the same damage and the module rebuilds (Task 16b).
  let rows: number | null = null;
  try {
    rows = createSearchIndexStore(db).rowCount();
  } catch (error) {
    logger.warn("search_index_count_failed", { err: error });
  }
  logger.info("search_index_size", { bytes: indexBytes(dbPath), rows });
  const client = createSearchClient({
    dbPath,
    clock: deps.clock,
    logger,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
  });
  const service = createSearchService({ client, sessions: deps.sessions });
  return {
    rpc: searchRpc(service),
    async stop() {
      await client.stop();
      db.close();
    },
  };
}
