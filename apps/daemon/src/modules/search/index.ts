import { join } from "node:path";
import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import type { Db } from "../../kernel/db/database.ts";
import { indexBytes, openSearchIndex, removeIndexFiles } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { type SearchRpc, searchRpc } from "./rpc.ts";
import { createScanner, type Scanner } from "./scanner.ts";
import type { FileContext, FileOutcome } from "./scanner-file.ts";
import { createSearchClient, type SearchClient, type SpawnThread } from "./search-client.ts";
import { createSearchService } from "./service.ts";
import { fsWatch, type WatchFactory } from "./watch.ts";

export const MAX_REBUILDS_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export interface SearchModule {
  readonly rpc: SearchRpc;
  /** Starts the scanner; called once the HTTP server listens, so a first scan never delays the boot (M4R74). */
  start(): void;
  stop(): Promise<void>;
}

interface Parts {
  /** Null once closed. */
  db: Db | null;
  readonly client: SearchClient;
  readonly scanner: Scanner;
}

export function createSearchModule(deps: {
  readonly home: string;
  /** Pi's agent folder as configured: the scanner reads `<agentDir>/sessions`, never a realpath of it. */
  readonly agentDir: string;
  readonly installedAt: number;
  /** The home was written by a newer pap: search.db may be a newer one too, so it is left alone (C §3.4). */
  readonly readOnly: boolean;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessions: SessionsScanPort;
  readonly spawn?: SpawnThread;
  readonly watch?: WatchFactory;
  readonly yieldNow?: () => Promise<void>;
  readonly process?: (path: string, ctx: FileContext) => FileOutcome;
}): SearchModule {
  const logger = deps.logger.child({ module: "search" });
  if (deps.readOnly) {
    // The scanner never starts in read-only mode (M4R124); there is no index to read either.
    logger.warn("search_disabled_read_only", {
      hint: "search.db is not opened, migrated or rebuilt while the database is read-only.",
    });
    return {
      rpc: { "search.query": async () => ({ hits: [] }) },
      start: () => {},
      stop: async () => {},
    };
  }
  const dbPath = join(deps.home, "search.db");
  let db: Db;
  try {
    db = openSearchIndex(dbPath, logger);
  } catch (error) {
    // The index is a cache that is safe to delete: one that cannot be opened (EACCES, ENOSPC, CANTOPEN) turns search
    // off for this run, never the daemon. Searches answer a typed error the palette shows.
    logger.warn("search_index_open_failed", { code: (error as { errcode?: unknown } | null)?.errcode });
    return {
      rpc: {
        "search.query": async () => {
          throw new PapError("internal");
        },
      },
      start: () => {},
      stop: async () => {},
    };
  }
  // No global cap: the size is said at boot and documented (owner Q14). A count that fails must not stop the boot: the
  // scanner meets the same damage and the module rebuilds (M4R127).
  try {
    const rows = createSearchIndexStore(db).rowCount();
    logger.info("search_index_size", { bytes: indexBytes(dbPath), rows });
  } catch (error) {
    logger.warn("search_index_count_failed", { err: error });
  }

  let started = false;
  let stopped = false;
  let unusable = false;
  let rebuilding: Promise<void> | null = null;
  const rebuilds: number[] = [];

  // Parts replaced by a rebuild are stopped first, so they report nothing more.
  const build = (index: Db): Parts => {
    const onDamaged = () => {
      void rebuild();
    };
    const client = createSearchClient({
      dbPath,
      clock: deps.clock,
      logger,
      onDamaged,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    });
    const scanner = createScanner({
      root: join(deps.agentDir, "sessions"),
      installedAt: deps.installedAt,
      store: createSearchIndexStore(index),
      sessions: deps.sessions,
      watch: deps.watch ?? fsWatch,
      clock: deps.clock,
      logger,
      onDamaged,
      ...(deps.yieldNow ? { yieldNow: deps.yieldNow } : {}),
      ...(deps.process ? { process: deps.process } : {}),
    });
    return { db: index, client, scanner };
  };
  let parts = build(db);

  const closeDb = (current: Parts): void => {
    const open = current.db;
    current.db = null;
    try {
      open?.close();
    } catch (error) {
      logger.debug("search_index_close_failed", { err: error });
    }
  };

  async function rebuildNow(): Promise<void> {
    const now = deps.clock.now();
    while (rebuilds.length > 0 && now - (rebuilds[0] ?? 0) >= HOUR_MS) rebuilds.shift();
    const old = parts;
    // `module.stop()` closes the database it finds: after a stop nothing is deleted or created (a stop wins).
    await old.scanner.stop();
    if (stopped) return;
    await old.client.stop();
    if (stopped) return;
    closeDb(old);
    if (rebuilds.length >= MAX_REBUILDS_PER_HOUR) {
      unusable = true;
      logger.error("search_index_unusable", {
        max: MAX_REBUILDS_PER_HOUR,
        hint: "Search is off until pap restarts.",
      });
      return;
    }
    rebuilds.push(now);
    removeIndexFiles(dbPath);
    const fresh = openSearchIndex(dbPath, logger);
    logger.warn("search_index_rebuilt", { reason: "damaged" });
    parts = build(fresh);
    if (started && !stopped) parts.scanner.start();
  }

  // One at a time; never rejects (callers fire and forget).
  function rebuild(): Promise<void> {
    if (stopped || unusable) return Promise.resolve();
    rebuilding ??= rebuildNow()
      .catch((error: unknown) => {
        unusable = true;
        try {
          logger.error("search_rebuild_failed", { err: error });
        } catch {
          // A broken logger must not turn into an unhandled rejection.
        }
      })
      .finally(() => {
        rebuilding = null;
      });
    return rebuilding;
  }

  const service = createSearchService({
    client: { query: (input) => parts.client.query(input) },
    sessions: deps.sessions,
  });
  return {
    rpc: searchRpc(service),
    start() {
      if (started || stopped) return;
      started = true;
      // During a rebuild the old scanner is stopped for good; the new one starts when the rebuild ends.
      if (!unusable && !rebuilding) parts.scanner.start();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await rebuilding;
        await parts.scanner.stop();
        await parts.client.stop();
      } finally {
        closeDb(parts);
      }
    },
  };
}
