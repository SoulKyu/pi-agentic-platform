import type { Clock } from "../../kernel/clock.ts";
import { blockedStrict } from "../../kernel/net/address-strict.ts";
import { guardedGet, type FetchResult, type Resolver } from "./guarded-get.ts";

export type { FetchError, FetchResult } from "./guarded-get.ts";
/** `totalMs` bounds this one request (never more than 15 s). */
export type Fetcher = (url: string, maxBytes: number, totalMs?: number) => Promise<FetchResult>;

// The only two places the daemon talks to for fonts, fixed in code (no setting, no env).
const CSS_HOST = "fonts.googleapis.com";
const FILE_HOST = "fonts.gstatic.com";

function allowedUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "")
    return false;
  if (url.hostname === CSS_HOST) return url.pathname === "/css2";
  return url.hostname === FILE_HOST && url.pathname.startsWith("/s/");
}

export interface GoogleFetchDeps {
  readonly clock: Clock;
  /** Tests only: replaces DNS. */
  readonly resolve?: Resolver;
}

/** The daemon's only egress for fonts: the two Google hosts, https, no redirect, every address through `blockedStrict`. */
export function createGoogleFetcher(deps: GoogleFetchDeps): Fetcher {
  return (url, maxBytes, totalMs) =>
    allowedUrl(url)
      ? guardedGet({
          url,
          maxBytes,
          ...(totalMs === undefined ? {} : { totalMs }),
          clock: deps.clock,
          allowAddress: (ip) => !blockedStrict(ip),
          ...(deps.resolve ? { resolve: deps.resolve } : {}),
        })
      : Promise.resolve({ ok: false, error: "host" });
}
