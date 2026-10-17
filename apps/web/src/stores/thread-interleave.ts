import type { ReactNode } from "react";

/**
 * What an agent's thread asks of the transcript (M11R118): the screen of the agent places its event cards, day
 * separators and folded prompts among the rows. Features never import each other, so the two sides share this file.
 */
export interface InterleaveRow {
  readonly key: string;
  /** When the row was written (ms); null when the entry carries no time. */
  readonly at: number | null;
  readonly author: "you" | "agent" | "other";
  readonly text: string;
}

export interface InterleavePlan {
  /** Nodes drawn before the row with that key (always a row that is drawn). */
  readonly before: ReadonlyMap<string, readonly ReactNode[]>;
  /** Nodes drawn after the last row. */
  readonly after: readonly ReactNode[];
  /** Rows not drawn: their text lives in a card. */
  readonly hidden: ReadonlySet<string>;
  /** Rows that start an author group of their own. */
  readonly breaks: ReadonlySet<string>;
}

export interface Interleave {
  /** `hasOlder`: older rows can still be loaded, so cards older than the loaded rows wait for them. */
  arrange(rows: readonly InterleaveRow[], hasOlder: boolean): InterleavePlan;
}
