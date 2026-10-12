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
  /** The home was written by a newer pap: search.db may be a newer one too, so it is left alone (C §3.4). */
  readonly readOnly?: boolean;
  readonly spawn?: SpawnThread;
}): SearchModule {
  const logger = deps.logger.child({ module: "search" });
  if (deps.readOnly) {
    logger.warn("search_disabled_read_only", {
      hint: "search.db is not opened, migrated or rebuilt while the database is read-only.",
    });
    return {
      rpc: { "search.query": async () => ({ hits: [] }) },
      stop: async () => {},
    };
  }
  const dbPath = join(deps.home, "search.db");
  const db = openSearchIndex(dbPath, logger);
  // No global cap: the size is said at boot and documented (owner Q14). A count that fails must not stop the boot: the
  // scanner meets the same damage and the module rebuilds (Task 16b).
  try {
    const rows = createSearchIndexStore(db).rowCount();
    logger.info("search_index_size", { bytes: indexBytes(dbPath), rows });
  } catch (error) {
    logger.warn("search_index_count_failed", { err: error });
  }
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
      try {
        await client.stop();
      } finally {
        db.close();
      }
    },
  };
}
