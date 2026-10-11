import type { EntryRef, TranscriptRow } from "@pap/contracts";
import { boundedRow, SNAPSHOT_ROWS } from "./snapshot.ts";

/** All the messages a run may keep, as serialised: a run of big tool results must not grow the daemon without limit. */
const RUN_BYTES = 1024 * 1024;

export interface RunViewState {
  /** How many bytes of the session file the run found when it began: everything before is on disk for sure. */
  readonly baselineBytes: number;
  /** Pi's leaf when the run began: the file is read along the branch that ends there (the run's own rows follow). */
  readonly leafAtStart: string | null;
  /** The rows the run has produced from the events the daemon saw; an id is bound as the entry's event arrives. */
  readonly rows: TranscriptRow[];
}

/**
 * What a transcript snapshot taken in the middle of a run needs besides the file. Pi writes an entry to the file
 * after its subscribers have seen it (S1, R38), so right after a `message_end` the file does not have that message
 * yet: reading it then would hand a client a snapshot that is missing a message whose event is already behind the
 * cursor. The daemon keeps the run's messages from the events it saw, and reads the file only up to where it ended
 * when the run began. Once the run has settled, the file is complete and this is empty.
 */
export interface RunView {
  begin(baselineBytes: number, leafAtStart: string | null): void;
  push(message: unknown): void;
  /** Gives `entry.id` to the newest row without an id that is the message of that entry. */
  bind(entry: EntryRef): void;
  /** A row the daemon builds from an entry (a compaction or a branch summary): it has its id already. */
  add(row: TranscriptRow): void;
  end(): void;
  state(): RunViewState | null;
}

// What identifies a message to its entry, taken before the message is replaced by a placeholder.
interface RowKey {
  readonly role: string | undefined;
  readonly toolCallId: string | undefined;
  readonly timestamp: number | undefined;
}

interface Held {
  entryId: string | null;
  readonly message: unknown;
  readonly size: number;
  readonly key: RowKey | null;
}

const keyOf = (message: unknown): RowKey => {
  const fields = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;
  return {
    role: typeof fields.role === "string" ? fields.role : undefined,
    toolCallId: typeof fields.toolCallId === "string" ? fields.toolCallId : undefined,
    timestamp: typeof fields.timestamp === "number" ? fields.timestamp : undefined,
  };
};

export function createRunView(): RunView {
  let current: { baselineBytes: number; leafAtStart: string | null; held: Held[]; bytes: number } | null =
    null;

  const trim = (run: NonNullable<typeof current>): void => {
    // A snapshot carries a bounded number of rows and bytes, so older ones of a long run are never needed again.
    while (run.held.length > SNAPSHOT_ROWS || (run.bytes > RUN_BYTES && run.held.length > 1)) {
      run.bytes -= run.held.shift()?.size ?? 0;
    }
  };

  return {
    begin(baselineBytes, leafAtStart) {
      current ??= { baselineBytes, leafAtStart, held: [], bytes: 0 };
    },
    push(message) {
      if (!current) return;
      // Measured before it is kept: a row over the per-row budget is only ever kept as its placeholder (R109).
      const { row, size } = boundedRow(message);
      current.held.push({ entryId: null, message: row, size: size + 1, key: keyOf(message) });
      current.bytes += size + 1;
      trim(current);
    },
    bind(entry) {
      if (!current) return;
      for (const held of current.held.toReversed()) {
        if (held.entryId !== null || held.key === null || entry.type !== "message") continue;
        const { key } = held;
        const same =
          entry.role === "toolResult" && entry.toolCallId !== undefined
            ? key.role === "toolResult" && key.toolCallId === entry.toolCallId
            : key.role === entry.role &&
              key.timestamp !== undefined &&
              key.timestamp === entry.messageTimestamp;
        if (!same) continue;
        held.entryId = entry.id;
        return;
      }
    },
    add(row) {
      if (!current) return;
      const { row: kept, size } = boundedRow(row.message);
      current.held.push({ entryId: row.entryId, message: kept, size: size + 1, key: null });
      current.bytes += size + 1;
      trim(current);
    },
    end() {
      current = null;
    },
    state: () =>
      current
        ? {
            baselineBytes: current.baselineBytes,
            leafAtStart: current.leafAtStart,
            rows: current.held.map(({ entryId, message }) => ({ entryId, message })),
          }
        : null,
  };
}
