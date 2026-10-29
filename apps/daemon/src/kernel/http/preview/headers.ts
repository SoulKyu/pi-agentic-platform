import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) and every header that would carry pap's identity, a capability or a client address
 * to the service. `Cookie` and `Authorization` never reach the VM (spec §4); `Referer` would carry the capability URL.
 */
const DROPPED_REQUEST: ReadonlySet<string> = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "referer",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "http2-settings",
  "forwarded",
  "x-real-ip",
]);

/**
 * The only headers of a service's answer the browser gets (UX2-R52, red team I10): what describes the body, its caching
 * validators and the page's own CORS answers. Everything else is dropped, so a header no browser knew of when this was written
 * (cookies, credentials prompts, device-bound sessions, client hints, storage access, reports, `Link` preconnects, HSTS,
 * `Alt-Svc`, `Clear-Site-Data`, `Refresh`, a policy of its own) never acts on pap's host. `Location` is rewritten apart.
 */
const KEPT_RESPONSE: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "vary",
  "date",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

/** The names a `Connection` header lists are hop-by-hop too (RFC 9110 §7.6.1). */
function connectionNames(value: string | string[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const part of [value ?? []].flat().join(",").split(","))
    if (part.trim() !== "") names.add(part.trim().toLowerCase());
  return names;
}

const isForwarding = (name: string): boolean => name.startsWith("x-forwarded-");

export interface RequestCleaning {
  /** The service's port in its VM: the `Host` it is sent. */
  readonly port: number;
  /** `/p/<token>`: the path the browser sees in front of the service's own paths (`X-Forwarded-Prefix`). */
  readonly prefix: string;
  /** A WebSocket upgrade keeps `Upgrade: websocket` and its `Sec-WebSocket-*` headers. */
  readonly websocket: boolean;
}

/** The request as the service gets it (spec §4): no cookie, no credential, no referrer, no client address. */
export function cleanRequestHeaders(
  incoming: IncomingHttpHeaders,
  input: RequestCleaning,
): OutgoingHttpHeaders {
  const listed = connectionNames(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_REQUEST.has(name) || listed.has(name) || isForwarding(name)) continue;
    out[name] = value;
  }
  out.host = `127.0.0.1:${input.port}`;
  out["x-forwarded-prefix"] = input.prefix;
  if (input.websocket) {
    out.connection = "Upgrade";
    out.upgrade = "websocket";
  } else {
    // One tunnel per request: the service closes after its answer, so no idle connection holds a tunnel.
    out.connection = "close";
  }
  return out;
}

/** Every answer of the untrusted origin carries these, a relayed one or the listener's own 404 (spec §4). */
export function untrustedHeaders(csp: string): Record<string, string> {
  return {
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "access-control-allow-origin": "*",
  };
}

export interface ResponseCleaning {
  readonly prefix: string;
  readonly port: number;
  /** The path of the request this answers (without its query), as the service saw it: a relative `Location` resolves against it. */
  readonly requestPath: string;
  readonly csp: string;
}

/**
 * The answer as the browser gets it: the allowed headers of the service, a `Location` only when it stays inside the
 * preview, then pap's own. A `401` keeps its status and loses `WWW-Authenticate` (no credentials prompt over pap's tab).
 */
export function cleanResponseHeaders(
  incoming: IncomingHttpHeaders,
  input: ResponseCleaning,
): OutgoingHttpHeaders {
  const listed = connectionNames(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || !KEPT_RESPONSE.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  const location = typeof incoming.location === "string" ? rewriteLocation(incoming.location, input) : null;
  if (location !== null) out.location = location;
  return { ...out, ...untrustedHeaders(input.csp) };
}

const MAX_LOCATION_CHARS = 8192;
const BASE = "http://preview.invalid";
const OWN_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A redirect from the service: pap never follows it (spec §4). A target inside the same preview comes back under its
 * prefix; any other (another origin, a scheme-relative URL, a path out of the prefix, a malformed value) is dropped, so
 * the browser stays on the 3xx body and no header sends the frame to another host.
 */
export function rewriteLocation(
  location: string,
  input: Pick<ResponseCleaning, "prefix" | "port" | "requestPath">,
): string | null {
  if (location.length === 0 || location.length > MAX_LOCATION_CHARS || /[\0-\x20\x7f\\]/.test(location))
    return null;
  let url: URL;
  try {
    // A path-absolute target names the service's own root, which the browser sees under the prefix.
    url =
      location.startsWith("/") && !location.startsWith("//")
        ? new URL(`${input.prefix}${location}`, BASE)
        : new URL(location, `${BASE}${input.prefix}${input.requestPath}`);
  } catch {
    return null;
  }
  const tail = `${url.search}${url.hash}`;
  if (url.origin === BASE)
    return url.pathname.startsWith(`${input.prefix}/`) ? `${url.pathname}${tail}` : null;
  const own = url.protocol === "http:" && OWN_HOSTS.has(url.hostname) && url.port === String(input.port);
  return own ? `${input.prefix}${url.pathname}${tail}` : null;
}

/** The only headers of a service's `101 Switching Protocols` the browser gets: the handshake, nothing else (no cookie). */
const UPGRADE_KEPT: readonly string[] = [
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];

/** The head of a relayed WebSocket handshake, as raw lines: `Upgrade` and `Connection` fixed, the handshake headers copied. */
export function upgradeHead(incoming: IncomingHttpHeaders): string {
  const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade"];
  for (const name of UPGRADE_KEPT) {
    const value = incoming[name];
    if (typeof value === "string" && !/[\r\n]/.test(value)) lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * A refusal written on a raw upgrade socket (no `ServerResponse` exists there): status line, pap's headers, no body. A
 * service that answers an upgrade with anything but `101` gets `rawRefusal(502)`: its own status, headers and body never
 * reach the socket (UX2-R52).
 */
export function rawRefusal(status: 403 | 404 | 413 | 502 | 503, csp: string): string {
  const reason = {
    403: "Forbidden",
    404: "Not Found",
    413: "Payload Too Large",
    502: "Bad Gateway",
    503: "Service Unavailable",
  }[status];
  const headers = Object.entries({ ...untrustedHeaders(csp), "content-length": "0", connection: "close" });
  return `HTTP/1.1 ${status} ${reason}\r\n${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`;
}
