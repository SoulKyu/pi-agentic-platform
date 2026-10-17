import type { AgentEventView } from "@pap/contracts";
import type { InterleaveRow } from "../../stores/thread-interleave.ts";

/** A pause this long between two rows starts a new author group (DESIGN §9.2). */
export const GROUP_GAP_MS = 5 * 60_000;

/** What is drawn among the transcript rows: a day separator, or a card with the prompt pap sent folded under it. */
export type Placed =
  | { readonly kind: "day"; readonly key: string; readonly at: number }
  | {
      readonly kind: "card";
      readonly key: string;
      readonly event: AgentEventView;
      /** The user message that followed the card and started with `[pap <kind> · …]`, else null. */
      readonly folded: string | null;
    };

export interface ThreadLayout {
  /** Drawn before the row with that key (a row that is drawn). */
  readonly before: ReadonlyMap<string, readonly Placed[]>;
  readonly after: readonly Placed[];
  /** Rows whose text moved into a card. */
  readonly hidden: ReadonlySet<string>;
  /** Rows that start a new author group. */
  readonly breaks: ReadonlySet<string>;
}

export interface LayoutOptions {
  /** An IANA zone; the browser's own when absent. Tests fix it. */
  readonly zone?: string;
  /** Older rows can still be loaded: a card older than the loaded rows waits for them. */
  readonly hasOlder: boolean;
}

/** The local calendar day of a time, as `YYYY-MM-DD`. */
export function dayKey(at: number, zone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(at);
}

// The first line of a prompt pap sent for the owner (`threadPromptLine` in the daemon): its kind is the card's kind.
const SENT_BY_PAP = /^\[pap (schedule|task|reminder|delegation) · /;

/**
 * Where the agent's cards, the day separators and the folded prompts go among the transcript rows (M11R118). A card goes
 * before the first row that is not older than it (a card is written before the prompt it sends). A `[pap <kind> · …]`
 * message of yours that comes right after the card of that kind is folded under it. A card, a day change or a pause of
 * five minutes starts a new author group.
 */
export function layoutThread(
  rows: readonly InterleaveRow[],
  events: readonly AgentEventView[],
  options: LayoutOptions,
): ThreadLayout {
  const firstAt = rows.find((row) => row.at !== null)?.at ?? null;
  const cards = events
    .filter((event) => !(options.hasOlder && firstAt !== null && event.at < firstAt))
    .toSorted((one, other) => one.at - other.at || one.id - other.id);
  const before = new Map<string, Placed[]>();
  const hidden = new Set<string>();
  const breaks = new Set<string>();
  let waiting: Placed[] = [];
  let lastDay: string | null = null;
  let lastRowAt: number | null = null;
  let next = 0;

  const markDay = (at: number) => {
    const day = dayKey(at, options.zone);
    if (lastDay !== null && day !== lastDay) waiting.push({ kind: "day", key: `day:${day}`, at });
    lastDay = day;
  };
  const placeCard = (event: AgentEventView) => {
    markDay(event.at);
    waiting.push({ kind: "card", key: `card:${event.id}`, event, folded: null });
  };

  let known: number | null = null;
  for (const row of rows) {
    const at: number | null = row.at ?? known;
    if (at !== null) known = at;
    while (at !== null && next < cards.length && (cards[next]?.at ?? Infinity) <= at) {
      placeCard(cards[next] as AgentEventView);
      next += 1;
    }
    // Waiting ends with a card only when no drawn row stands between it and this one.
    const last = waiting.at(-1);
    const card = last?.kind === "card" && last.folded === null ? last : null;
    const sent = row.author === "you" ? SENT_BY_PAP.exec(row.text) : null;
    if (sent !== null && card !== null && card.event.kind === sent[1]) {
      hidden.add(row.key);
      waiting[waiting.length - 1] = { ...card, folded: row.text };
      continue;
    }
    if (at !== null) markDay(at);
    if (waiting.length > 0 || (lastRowAt !== null && at !== null && at - lastRowAt >= GROUP_GAP_MS))
      breaks.add(row.key);
    if (waiting.length > 0) before.set(row.key, waiting);
    waiting = [];
    if (at !== null) lastRowAt = at;
  }
  while (next < cards.length) {
    placeCard(cards[next] as AgentEventView);
    next += 1;
  }
  return { before, after: waiting, hidden, breaks };
}
