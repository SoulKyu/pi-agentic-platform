import { existsSync, readFileSync } from "node:fs";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_ROWS } from "./snapshot.ts";

/**
 * The last messages of the active branch of a Pi session file. Pure parsing: it never writes the file and never
 * migrates it on disk. `upToBytes` reads only the start of the file, which is how a run in progress is left out of
 * it: Pi writes an entry after its subscribers have seen it, so what a run has produced is not in the file yet.
 */
export function readTranscriptTail(filePath: string, limit = SNAPSHOT_ROWS, upToBytes?: number): unknown[] {
  if (!existsSync(filePath)) return [];
  try {
    const bytes = readFileSync(filePath);
    const text = (upToBytes === undefined ? bytes : bytes.subarray(0, upToBytes)).toString("utf8");
    const entries = parseSessionEntries(text);
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
    return buildSessionContext(sessionEntries).messages.slice(-limit);
  } catch {
    return [];
  }
}
