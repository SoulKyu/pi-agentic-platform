import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { createRateLimiter } from "../rate-limit.ts";
import type { OriginRefused } from "./origin.ts";

/** One line per kind of refusal in this window: a page that retries cannot flood the log. */
export const ORIGIN_REFUSED_EVERY_MS = 10_000;
/** The Origin is attacker-controlled text: only this much of it reaches the log. */
const MAX_ORIGIN_CHARS = 100;

/**
 * The log line behind a 403 from the Origin check (HTTP and WebSocket). Without it, `--host 0.0.0.0` with no
 * PAP_PUBLIC_ORIGIN shows the browser a bare "forbidden" and the operator nothing. It carries the clipped Origin and
 * how many refusals the window swallowed; never a cookie, a header or a path.
 */
export function createOriginRefusalLog(logger: Logger, clock: Clock): OriginRefused {
  const limiter = createRateLimiter(clock, ORIGIN_REFUSED_EVERY_MS);
  return (via, origin) => {
    const said = limiter.check(via);
    if (!said.allowed) return;
    logger.warn("origin_refused", {
      via,
      origin:
        origin === undefined
          ? "(none)"
          : origin.length > MAX_ORIGIN_CHARS
            ? `${origin.slice(0, MAX_ORIGIN_CHARS)}…`
            : origin,
      suppressed: said.suppressed,
      hint: "A browser is only accepted under the address in PAP_PUBLIC_ORIGIN (or the loopback addresses). Set PAP_PUBLIC_ORIGIN to the address in its address bar.",
    });
  };
}
