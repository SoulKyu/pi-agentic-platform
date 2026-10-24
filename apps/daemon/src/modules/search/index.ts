import { mkdirSync } from "node:fs";
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
/** Pap's mirrors of VM session files, one folder per box; `start` makes the two parents so the watches can be set. */
const MIRROR_PARENTS = ["agents", "boxes"] as const;

/** A watch that stays silent about a folder that does not exist yet: the reconcile finds it when it appears. */
const quietWhenAbsent =
  (watch: WatchFactory): WatchFactory =>
  (dir, onEvent, onError) => {
    let setUp = false;
    const close = watch(dir, onEvent, (code) => {
      if (!(setUp === false && code === "ENOENT")) onError(code);
    });
    setUp = true;
    return close;
  };

/** One scanner per root over the same index; `reconcile` and `idle` run for all. */
function scanAll(scanners: readonly Scanner[]): Scanner {
  return {
    start: () => scanners.forEach((scanner) => scanner.start()),
    stop: async () => void (await Promise.all(scanners.map((scanner) => scanner.stop()))),
    idle: async () => void (await Promise.all(scanners.map((scanner) => scanner.idle()))),
    reconcile: async () => void (await Promise.all(scanners.map((scanner) => scanner.reconcile()))),
  };
}
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
    const store = createSearchIndexStore(index);
    const scannerOver = (root: string, watch: WatchFactory): Scanner =>
      createScanner({
        root,
        installedAt: deps.installedAt,
        store,
        sessions: deps.sessions,
        watch,
        clock: deps.clock,
        logger,
        onDamaged,
        ...(deps.yieldNow ? { yieldNow: deps.yieldNow } : {}),
        ...(deps.process ? { process: deps.process } : {}),
      });
    const watch = deps.watch ?? fsWatch;
    // A mirror file is indexed only when a session row holds its path: the sessions port decides (claim).
    const scanner = scanAll([
      scannerOver(join(deps.agentDir, "sessions"), watch),
      ...MIRROR_PARENTS.map((parent) =>
        scannerOver(join(deps.home, parent, ".mirrors"), quietWhenAbsent(watch)),
      ),
    ]);
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
      // The mirror folders exist before the watches: a first box session after the boot is indexed when it writes, not
      // up to a reconcile later. Private like the folders the sessions make in them.
      for (const parent of MIRROR_PARENTS) {
        try {
          mkdirSync(join(deps.home, parent, ".mirrors"), { recursive: true, mode: 0o700 });
        } catch (error) {
          logger.warn("search_mirror_folder_not_made", { parent, err: error });
        }
      }
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
