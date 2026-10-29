import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { createRateLimiter } from "../rate-limit.ts";
import type { FetchSiteRefused } from "./fetch-site.ts";

/** One line per `via` in this window: a page that retries cannot flood the log. */
export const FETCH_SITE_REFUSED_EVERY_MS = 10_000;

/**
 * The log line behind a 403 from the Sec-Fetch-Site check (HTTP and WebSocket). The header is attacker-controlled
 * text: only one of the two refused kinds ever reaches the log, never the raw value, a cookie, a header or a path.
 */
export function createFetchSiteRefusalLog(logger: Logger, clock: Clock): FetchSiteRefused {
  const limiter = createRateLimiter(clock, FETCH_SITE_REFUSED_EVERY_MS);
  return (via, site) => {
    const said = limiter.check(via);
    if (!said.allowed) return;
    logger.warn("fetch_site_refused", {
      via,
      site: site.toLowerCase() === "same-site" ? "same-site" : "cross-site",
      suppressed: said.suppressed,
    });
  };
}
