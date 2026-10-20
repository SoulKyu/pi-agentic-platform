import type { Clock } from "../../kernel/clock.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import type { OwnerSecrets } from "./owner-secrets.ts";

/** The owner's values are read again at most this often (never per line). */
export const REDACTOR_REFRESH_MS = 60_000;
/** A collection that takes longer is given up on: the last good set (or the well-known formats alone) is used. */
export const REDACTOR_COLLECT_DEADLINE_MS = 10_000;
const MASK = "[REDACTED]";

/** Every place a needle occurs, merged where they overlap or touch, so two overlapping values are masked whole. */
function mask(line: string, needles: readonly string[]): string {
  const spans: Array<[number, number]> = [];
  for (const needle of needles)
    if (needle !== "")
      for (let at = line.indexOf(needle); at !== -1; at = line.indexOf(needle, at + 1))
        spans.push([at, at + needle.length]);
  if (spans.length === 0) return line;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  let current = spans[0] as [number, number];
  const close = (): void => {
    out += line.slice(cursor, current[0]) + MASK;
    cursor = current[1];
  };
  for (const span of spans.slice(1)) {
    if (span[0] <= current[1]) current = [current[0], Math.max(current[1], span[1])];
    else {
      close();
      current = span;
    }
  }
  close();
  return out + line.slice(cursor);
}

/**
 * The relay's stderr (AVM-E40 M8): each line has every known value (and its JSON-escaped form) masked, then the well-known
 * secret formats scrubbed. The values come from the owner-secrets collector, refreshed once a minute, with a deadline, and shared
 * by the lines that arrive meanwhile. A collector that fails or hangs leaves the last good set in use; before any success only
 * the well-known formats are scrubbed. Logging never waits longer than the deadline.
 */
export function createStderrRedactor(deps: {
  readonly clock: Clock;
  readonly collect: () => Promise<Pick<OwnerSecrets, "secrets">>;
}): (line: string) => Promise<string> {
  const { clock } = deps;
  let needles: readonly string[] = [];
  let at = Number.NEGATIVE_INFINITY;
  let flight: Promise<void> | null = null;
  const collected = (): Promise<Pick<OwnerSecrets, "secrets">> =>
    new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new Error("deadline")), REDACTOR_COLLECT_DEADLINE_MS);
      deps.collect().then(
        (value) => (clock.clearTimeout(timer), resolve(value)),
        (error: unknown) => (clock.clearTimeout(timer), reject(error as Error)),
      );
    });
  const refresh = (): Promise<void> => {
    flight ??= collected()
      .then(({ secrets }) => {
        const forms = new Set<string>();
        for (const value of secrets) {
          forms.add(value);
          forms.add(JSON.stringify(value).slice(1, -1));
        }
        needles = [...forms];
      })
      // The collector logs its own failure; a deadline or a failure keeps the last good set.
      .catch(() => {})
      .finally(() => {
        // A failed refresh is not retried before the next minute either: a broken source is not asked on every line.
        at = clock.now();
        flight = null;
      });
    return flight;
  };
  return async (line) => {
    if (clock.now() - at >= REDACTOR_REFRESH_MS) await refresh();
    return scrubKnownSecrets(mask(line, needles)).text;
  };
}
