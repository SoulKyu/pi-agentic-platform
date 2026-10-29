/**
 * Decision 139, red team I1: what each GET route does with a request that carries pap's cookie from a page pap did not write.
 * On plain HTTP to a LAN address (`--host <LAN IP> --insecure-http`) no browser sends Fetch Metadata, so the `Sec-Fetch-Site`
 * refusal never fires, and WebKit sends pap's cookie on the GETs of a framed preview. Reads stay blocked by CORS and CORP, and
 * every POST and the WebSocket by their Origin checks; a GET has no such check, so a GET route must never change anything
 * on its own:
 * - `side-effect-free`: it changes nothing a page could want (a read; `/auth/status` slides the caller's own session);
 * - `nonce-bound`: it changes something only with a single-use value pap issued to that same user (a state, a ticket, an
 *   export token), which a page of another origin cannot read;
 * - `origin-checked`: the WebSocket handshake, which browsers always send with `Origin` (`null` from a preview), refused
 *   unless it is one of pap's;
 * - `public`: reads no cookie.
 * A route that changes state without a nonce has no class: `get-routes.int.test.ts` fails until it is fixed or classified.
 */
export type GetEffect = "side-effect-free" | "nonce-bound" | "origin-checked" | "public";

export const GET_EFFECT: Readonly<Record<string, GetEffect>> = {
  "GET /healthz": "public",
  "GET /metrics": "public",
  "GET /auth/status": "side-effect-free",
  "GET /files/raw": "side-effect-free",
  "GET /fonts/:slug/:file": "side-effect-free",
  "GET /api/sessions/:sessionId/export/:token": "nonce-bound",
  "GET /github/app/new": "nonce-bound",
  "GET /github/app/created": "nonce-bound",
  "GET /github/app/authorized": "nonce-bound",
  "GET /github/app/authorized/finish": "nonce-bound",
  "GET /ws": "origin-checked",
};

/** Hono's middleware and catch-alls: they answer no route of their own. */
export const GET_MIDDLEWARE: ReadonlySet<string> = new Set([
  "ALL /*",
  "ALL /auth/*",
  "ALL /fonts",
  "ALL /fonts/*",
  "ALL /github/*",
]);
