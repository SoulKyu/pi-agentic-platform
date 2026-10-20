import type { Clock } from "../../kernel/clock.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import type { OwnerSecrets } from "./owner-secrets.ts";

/** The owner's values are read again at most this often (never per line). */
export const REDACTOR_REFRESH_MS = 60_000;
const MASK = "[REDACTED]";
export const WITHHELD_LINE = "[line withheld]";

/**
 * The relay's stderr (AVM-E40 M8): each line has every known value (and its JSON-escaped form) masked, then the well-known
 * secret formats scrubbed. The values come from the owner-secrets collector, refreshed once a minute and shared by the lines
 * that arrive meanwhile. While no value has ever been read (the collector fails), a line is withheld rather than let through.
 */
export function createStderrRedactor(deps: {
  readonly clock: Clock;
  readonly collect: () => Promise<Pick<OwnerSecrets, "secrets">>;
}): (line: string) => Promise<string> {
  let needles: readonly string[] | null = null;
  let at = Number.NEGATIVE_INFINITY;
  let flight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    flight ??= deps
      .collect()
      .then(({ secrets }) => {
        const forms = new Set<string>();
        for (const value of secrets) {
          forms.add(value);
          forms.add(JSON.stringify(value).slice(1, -1));
        }
        needles = [...forms].sort((a, b) => b.length - a.length);
      })
      .catch(() => {})
      .finally(() => {
        // A failed refresh is not retried before the next minute either: a broken source is not asked on every line.
        at = deps.clock.now();
        flight = null;
      });
    return flight;
  };
  return async (line) => {
    if (deps.clock.now() - at >= REDACTOR_REFRESH_MS) await refresh();
    if (needles === null) return WITHHELD_LINE;
    let out = line;
    for (const needle of needles) if (needle !== "") out = out.split(needle).join(MASK);
    return scrubKnownSecrets(out).text;
  };
}
