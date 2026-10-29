import type { MiddlewareHandler } from "hono";
import { isHookRequest } from "./hook-path.ts";
import { isReserved } from "./reserved.ts";

/** Told of every request refused for its `Sec-Fetch-Site`: the composition root logs it, rate-limited (`fetch_site_refused`). */
export type FetchSiteRefused = (via: "http" | "ws", site: string) => void;

/** The only values that pass: our own origin, and a user-typed or bookmarked address. Same-site (SameSite ignores ports, so the preview origin is same-site with pap), cross-site and any future value are refused (spec §4). */
const PASSING: ReadonlySet<string> = new Set(["same-origin", "none"]);
/** GitHub sends the browser back to these after the App manifest and the install (`auth.md`, "GitHub callbacks"). */
const GITHUB_CALLBACKS: ReadonlySet<string> = new Set(["/github/app/created", "/github/app/authorized"]);

export interface FetchMeta {
  readonly method: string;
  readonly path: string;
  readonly site: string | undefined;
  readonly mode: string | undefined;
  readonly dest: string | undefined;
}

/**
 * Whether a request is refused for where it comes from. A request without `Sec-Fetch-Site` (a browser before Safari 16.4,
 * a program) keeps today's checks: the Origin guard, SameSite=Strict cookies, the WebSocket Origin rule. The exceptions:
 * a webhook, the two GitHub callbacks (a cross-site document navigation), and a top-level navigation to the app shell (a link or a typed address opens pap;
 * every route, the WebSocket and every embed stay refused).
 */
export function fetchSiteRefused(meta: FetchMeta): boolean {
  if (meta.site === undefined) return false;
  const site = meta.site.toLowerCase();
  if (PASSING.has(site)) return false;
  if (isHookRequest(meta.method, meta.path)) return false;
  if (
    meta.method === "GET" &&
    GITHUB_CALLBACKS.has(meta.path) &&
    site === "cross-site" &&
    meta.mode === "navigate" &&
    meta.dest === "document"
  )
    return false;
  const navigation =
    (meta.method === "GET" || meta.method === "HEAD") &&
    meta.mode === "navigate" &&
    (meta.dest === undefined || meta.dest === "document");
  return !(navigation && !isReserved(meta.path));
}

/** Every route of the app: 403 `forbidden` for a refused site, before the Origin guard and any route runs. */
export function fetchSiteGuard(onRefused?: FetchSiteRefused): MiddlewareHandler {
  return async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    const meta = {
      method: c.req.method,
      path: c.req.path,
      site,
      mode: c.req.header("sec-fetch-mode"),
      dest: c.req.header("sec-fetch-dest"),
    };
    if (fetchSiteRefused(meta)) {
      onRefused?.("http", site ?? "");
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    await next();
  };
}
