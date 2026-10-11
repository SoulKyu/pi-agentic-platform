import { boundedRow, SNAPSHOT_ROWS } from "./snapshot.ts";

/** All the messages a run may keep, as serialised: a run of big tool results must not grow the daemon without limit. */
const RUN_BYTES = 1024 * 1024;

export interface RunViewState {
  /** How many bytes of the session file the run found when it began: everything before is on disk for sure. */
  readonly baselineBytes: number;
  /** The messages the run has produced, from the events the daemon saw. */
  readonly messages: unknown[];
}

/**
 * What a transcript snapshot taken in the middle of a run needs besides the file. Pi writes an entry to the file
 * after its subscribers have seen it (S1, R38), so right after a `message_end` the file does not have that message
 * yet: reading it then would hand a client a snapshot that is missing a message whose event is already behind the
 * cursor. The daemon keeps the run's messages from the events it saw, and reads the file only up to where it ended
 * when the run began. Once the run has settled, the file is complete and this is empty.
 */
export interface RunView {
  begin(baselineBytes: number): void;
  push(message: unknown): void;
  end(): void;
  state(): RunViewState | null;
}

export function createRunView(): RunView {
  let current: { baselineBytes: number; messages: unknown[]; sizes: number[]; bytes: number } | null = null;
  return {
    begin(baselineBytes) {
      current ??= { baselineBytes, messages: [], sizes: [], bytes: 0 };
    },
    push(message) {
      if (!current) return;
      // Measured before it is kept: a row over the per-row budget is only ever kept as its placeholder (R109).
      const { row, size } = boundedRow(message);
      current.messages.push(row);
      current.sizes.push(size + 1);
      current.bytes += size + 1;
      // A snapshot carries a bounded number of rows and bytes, so older ones of a long run are never needed again.
      while (
        current.messages.length > SNAPSHOT_ROWS ||
        (current.bytes > RUN_BYTES && current.messages.length > 1)
      ) {
        current.messages.shift();
        current.bytes -= current.sizes.shift() ?? 0;
      }
    },
    end() {
      current = null;
    },
    state: () => (current ? { baselineBytes: current.baselineBytes, messages: [...current.messages] } : null),
  };
}
