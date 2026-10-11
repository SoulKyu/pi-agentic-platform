import { type Clock, createSystemClock } from "../../kernel/clock.ts";
import { type Logger, silentLogger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import {
  type BranchPage,
  type Convert,
  findToolCall,
  type ForkPoint,
  forkPoints,
  readBranchPage,
} from "./branch.ts";
import { createEntriesCache } from "./entries-cache.ts";
import { SNAPSHOT_ROWS } from "./snapshot.ts";
import { clipMessage } from "./wire-clip.ts";

type Sdk = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  "migrateSessionEntries" | "sessionEntryToContextMessages" | "CURRENT_SESSION_VERSION"
>;

export interface TranscriptReader {
  /**
   * A page of the branch that ends at `leafId` (the file's last entry when none), without the system prompt Pi keeps
   * in the file (R107), rows clipped for the wire. Pure parsing: it never writes the file and never migrates it on
   * disk. `upToBytes` reads only the start of the file, which is how a run in progress is left out of it: Pi writes an
   * entry after its subscribers have seen it, so what a run has produced is not in the file yet. A file that is
   * missing or cannot be read is an empty page.
   */
  page(
    filePath: string,
    options?: { leafId?: string | null; before?: string; limit?: number; upToBytes?: number },
  ): BranchPage;
  forks(filePath: string, leafId?: string | null): ForkPoint[];
  /** A tool call's arguments and result along the branch that ends at `leafId` (null: the file's last entry). */
  toolCall(
    filePath: string,
    toolCallId: string,
    leafId?: string | null,
  ): { result: unknown | null; args: unknown | null };
  lastEntryId(filePath: string): string | null;
}

/** The same log line is said at most this often: a damaged file read on every snapshot cannot flood the log. */
const SAY_EVERY_MS = 10_000;
const TYPE_CHARS = 64;

function createTranscriptReader(sdk: Sdk, logger: Logger, clock: Clock): TranscriptReader {
  const limiter = createRateLimiter(clock, SAY_EVERY_MS);
  // No path in the log lines: the size and the kind of issue are enough to act on.
  const cache = createEntriesCache(sdk as never, {
    onIssue: (issue, size) => {
      const said = limiter.check(`session_file_issue:${issue}`);
      if (said.allowed) logger.warn("session_file_issue", { issue, size, suppressed: said.suppressed });
    },
  });
  // An entry Pi's helper refuses shows as nothing, never as a blank transcript, and is said (M2-RT-33).
  const convert: Convert = (entry) => {
    try {
      return sdk.sessionEntryToContextMessages(entry as never);
    } catch {
      const said = limiter.check("transcript_entry_unreadable");
      if (said.allowed) {
        logger.warn("transcript_entry_unreadable", {
          type: String(entry.type).slice(0, TYPE_CHARS),
          suppressed: said.suppressed,
        });
      }
      return [];
    }
  };
  return {
    page(filePath, options = {}) {
      const page = readBranchPage(cache.read(filePath, options.upToBytes), convert, {
        leafId: options.leafId,
        before: options.before,
        limit: options.limit ?? SNAPSHOT_ROWS,
      });
      return {
        ...page,
        rows: page.rows.map((row) => ({ entryId: row.entryId, message: clipMessage(row.message) })),
      };
    },
    forks: (filePath, leafId) => forkPoints(cache.read(filePath), convert, leafId),
    toolCall: (filePath, toolCallId, leafId) => findToolCall(cache.read(filePath), toolCallId, leafId),
    lastEntryId: (filePath) => cache.read(filePath).list.at(-1)?.id ?? null,
  };
}

let loading: Promise<TranscriptReader> | undefined;

/**
 * The Pi SDK is not loaded until a transcript is read: it costs the daemon about 120 MB of resident memory and half a
 * second (R108). The first call loads it; every later call, concurrent or not, gets the same reader (the first call's
 * logger and clock are the reader's). A load that fails is not remembered, so the next call tries again.
 */
export function loadTranscriptReader(
  options: { logger?: Logger; clock?: Clock } = {},
): Promise<TranscriptReader> {
  loading ??= import("@earendil-works/pi-coding-agent").then(
    (sdk) =>
      createTranscriptReader(sdk, options.logger ?? silentLogger, options.clock ?? createSystemClock()),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
