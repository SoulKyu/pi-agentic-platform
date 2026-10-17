import type { Systemd } from "./systemd.ts";
import { readJournal } from "./unit.ts";

export type Readiness =
  | { kind: "url"; url: string }
  | { kind: "owner" }
  | { kind: "never" }
  /** The journal holds nothing at all for the unit (volatile journal, W5-R18): the start could not be checked. */
  | { kind: "unreadable" };

const DEFAULT_READS = 40;
const POLL_MS = 500;
/** Empty reads before `--since` is tried: while the new process boots, a time-based match could show the previous start. */
const FALLBACK_AFTER_EMPTY_READS = 4;

/** `YYYY-MM-DD HH:MM:SS UTC`, the seconds floored: the only journal start time `Systemd.journal` accepts. */
export const journalTime = (at: Date): string => `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;

/**
 * Readiness is the daemon's own `listening` journal line, never `is-active` (Type=simple says active while the port is
 * taken). `listening` with a loopback setup URL of the installed port: that URL; `listening` alone on two consecutive
 * reads (the daemon logs `listening` just before `setup_url`): an owner exists; no line after about 20 s: the daemon
 * never bound (port taken, home locked, crash loop), or, when the journal holds nothing at all for the unit, the journal
 * is not readable and nothing is known. `reads` (default 40, about 20 s) lets a caller wait in shorter chunks.
 */
export async function waitForListening(
  deps: { systemd: Systemd; sleep(ms: number): Promise<void>; now(): Date },
  unit: string,
  since: Date,
  port: number,
  reads: number = DEFAULT_READS,
): Promise<Readiness> {
  const sinceUtc = journalTime(since);
  let emptyReads = 0;
  let listeningWithoutUrl = false;
  for (let read = 1; read <= reads; read++) {
    const id = await deps.systemd.invocationId(unit); // null right after the restart
    let sawListeningWithoutUrl = false;
    if (id !== null) {
      const text = await deps.systemd.journal(id, sinceUtc, emptyReads >= FALLBACK_AFTER_EMPTY_READS);
      if (text.trim() === "") emptyReads++;
      const facts = readJournal(text, port);
      if (facts.listening && facts.setupUrl !== null) return { kind: "url", url: facts.setupUrl };
      sawListeningWithoutUrl = facts.listening;
      if (sawListeningWithoutUrl && listeningWithoutUrl) return { kind: "owner" };
    }
    listeningWithoutUrl = sawListeningWithoutUrl;
    if (read < reads) await deps.sleep(POLL_MS);
  }
  return (await deps.systemd.journalAny(sinceUtc)).trim() === "" ? { kind: "unreadable" } : { kind: "never" };
}
