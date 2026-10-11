import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_ROWS } from "./snapshot.ts";

type Sdk = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  "buildSessionContext" | "migrateSessionEntries" | "parseSessionEntries"
>;

export interface TranscriptReader {
  /**
   * The last messages of the active branch of a Pi session file, without the system prompt Pi keeps in it (R107). Pure
   * parsing: it never writes the file and never migrates it on disk. `upToBytes` reads only the start of the file,
   * which is how a run in progress is left out of it: Pi writes an entry after its subscribers have seen it, so what a
   * run has produced is not in the file yet. A file that is missing or cannot be parsed is an empty transcript.
   */
  tail(filePath: string, limit?: number, upToBytes?: number): unknown[];
}

// Only the bytes asked for are read, and only once: a session file of tens of megabytes is not read to show 75 rows
// of the first few.
function readStart(filePath: string, upToBytes: number | undefined): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = upToBytes === undefined ? size : Math.min(size, upToBytes);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return buffer.toString("utf8", 0, filled);
  } finally {
    closeSync(fd);
  }
}

function createTranscriptReader(sdk: Sdk): TranscriptReader {
  return {
    tail(filePath, limit = SNAPSHOT_ROWS, upToBytes) {
      try {
        const text = readStart(filePath, upToBytes);
        if (text === null) return [];
        const entries = sdk.parseSessionEntries(text);
        sdk.migrateSessionEntries(entries);
        const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
        return sdk
          .buildSessionContext(sessionEntries)
          .messages.filter((message) => (message as { role?: unknown }).role !== "system")
          .slice(-limit);
      } catch {
        return [];
      }
    },
  };
}

let loading: Promise<TranscriptReader> | undefined;

/**
 * The Pi SDK is not loaded until a transcript is read: it costs the daemon about 120 MB of resident memory and half a
 * second (R108). The first call loads it; every later call, concurrent or not, gets the same reader. A load that
 * fails is not remembered, so the next call tries again.
 */
export function loadTranscriptReader(): Promise<TranscriptReader> {
  loading ??= import("@earendil-works/pi-coding-agent").then(createTranscriptReader, (error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
