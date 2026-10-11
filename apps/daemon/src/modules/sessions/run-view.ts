import { SNAPSHOT_ROWS } from "./snapshot.ts";

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
  let current: { baselineBytes: number; messages: unknown[] } | null = null;
  return {
    begin(baselineBytes) {
      current ??= { baselineBytes, messages: [] };
    },
    push(message) {
      if (!current) return;
      current.messages.push(message);
      // A snapshot carries a bounded number of rows, so older ones of a long run are never needed again.
      if (current.messages.length > SNAPSHOT_ROWS) current.messages.shift();
    },
    end() {
      current = null;
    },
    state: () => (current ? { baselineBytes: current.baselineBytes, messages: [...current.messages] } : null),
  };
}
