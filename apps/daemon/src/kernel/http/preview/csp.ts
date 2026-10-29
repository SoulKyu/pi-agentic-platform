import { tryParseHostEntry } from "@pap/contracts";
import { ipAlwaysRefused } from "../../net/vm-address.ts";

/** CSP source expressions have no IPv6 literal form: an origin with one is left out rather than written invalid. */
export const ancestorsOf = (appOrigins: readonly string[]): string => {
  const usable = appOrigins.filter((origin) => !origin.includes("["));
  return usable.length === 0 ? "'none'" : usable.join(" ");
};

/** `ws://` for `http://`, `wss://` for `https://`: CSP3 never lets an `http:` source match a WebSocket URL. */
export const socketOriginOf = (origin: string): string => origin.replace(/^http(s?):/, "ws$1:");

/** One source a networked service's page may reach: a scheme, a host (or `*.` and a name) or an IPv4, an optional port. */
const SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;
const SCHEMES = ["http", "https", "ws", "wss"] as const;
/** The hosts of one page's CSP stop at this many characters; the entries past it are left out (a stricter page, never a wider one). */
export const MAX_HOST_SOURCE_CHARS = 8192;

/** Loopback names and addresses: the egress proxy never reaches them (`blocked_address`), so neither does a page. */
const isLoopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * Decision 139: a networked service's page reaches, in the owner's browser, what its session's egress list lets the service
 * reach, read from the daemon's records when the token is minted and frozen in its grant. Each entry is parsed by the proxy's
 * own parser (`tryParseHostEntry`): `host` and `*.name` become the four schemes on their default ports (80 and 443, the ports
 * the proxy allows a bare entry), `host:port` the four schemes on that port. Left out: an IPv6 literal (no CSP form), a loopback
 * name or address, any IP entry the proxy always refuses (`ipAlwaysRefused`: the pap0 subnet, 0.0.0.0/8, link-local, CGNAT, multicast,
 * documentation and the other strict ranges; an exact RFC 1918 entry stays, as in the proxy), and any entry that names one of
 * pap's own hosts (any port), so no list ever opens pap's origins to a page.
 *
 * `ownHosts`: the host names and every address of the host itself; the caller (T10) passes `hostAddressesNow()` plus the
 * hosts of the app and preview origins.
 */
export function hostSources(entries: readonly string[], ownHosts: readonly string[]): string[] {
  const own = ownHosts.map((host) => host.toLowerCase().replace(/^\[|\]$/g, ""));
  const sources = new Set<string>();
  let chars = 0;
  for (const raw of entries) {
    const entry = tryParseHostEntry(raw);
    if (entry === null || (entry.ip && entry.host.includes(":"))) continue;
    const names = (host: string): boolean =>
      entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
    if (isLoopback(entry.host) || own.some(names)) continue;
    if (entry.ip && ipAlwaysRefused(entry.host, own)) continue;
    const port = entry.ports.length === 1 ? `:${entry.ports[0]}` : "";
    const host = entry.wildcard ? `*.${entry.host}` : entry.host;
    const fresh = SCHEMES.map((scheme) => `${scheme}://${host}${port}`).filter(
      (source) => SOURCE.test(source) && !sources.has(source),
    );
    const cost = fresh.reduce((sum, source) => sum + source.length + 1, 0);
    if (chars + cost > MAX_HOST_SOURCE_CHARS) break;
    chars += cost;
    for (const source of fresh) sources.add(source);
  }
  return [...sources];
}

export interface ServiceCspInput {
  readonly appOrigins: readonly string[];
  /** The preview origin, always named: in an opaque-origin document browsers disagree on what `'self'` matches. */
  readonly previewOrigin: string;
  /** `hostSources` of the session's egress list, frozen in the grant; empty for a service without network. */
  readonly hosts: readonly string[];
}

/**
 * A service's page (spec §4, decision 139): an opaque origin (no cookie, no storage, `Origin: null`) framed only by pap's own
 * pages, which reaches the preview origin plus `data:` and `blob:` and, for a networked session, its egress hosts. Nested
 * documents and workers come from the preview origin (or a listed host) only, never `data:` or `blob:`, since a browser
 * applies the page's CSP to those only where it inherits its policy; `<object>` and `<embed>` load nothing. `form-action` and
 * `base-uri` never fall back to `default-src`, so they are spelled out. No `allow-popups` (decision 139).
 */
export function serviceCsp({ appOrigins, previewOrigin, hosts }: ServiceCspInput): string {
  const reach = [previewOrigin, ...hosts].join(" ");
  return [
    "sandbox allow-scripts allow-forms allow-downloads",
    `default-src ${reach} data: blob: 'unsafe-inline' 'unsafe-eval'`,
    `connect-src ${previewOrigin} ${socketOriginOf(previewOrigin)}${hosts.length === 0 ? "" : ` ${hosts.join(" ")}`} data: blob:`,
    `frame-src ${reach}`,
    `child-src ${reach}`,
    `worker-src ${previewOrigin}`,
    "object-src 'none'",
    `form-action ${reach}`,
    `base-uri ${previewOrigin}`,
    `frame-ancestors ${ancestorsOf(appOrigins)}`,
  ].join("; ");
}

/** An HTML artifact (decision 4): scripts run, nothing loads or submits anywhere. */
export const artifactCsp = (appOrigins: readonly string[]): string =>
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  `form-action 'none'; base-uri 'none'; frame-ancestors ${ancestorsOf(appOrigins)}`;
