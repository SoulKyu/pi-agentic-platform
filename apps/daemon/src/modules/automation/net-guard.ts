import type { LookupAddress, LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  // IPv4-compatible (`::a.b.c.d`, deprecated) and IPv4-translated (`::ffff:0:a.b.c.d`, SIIT): both embed an IPv4
  // address; `::` and `::1` are inside the first. Neither rule touches IPv4 or IPv4-mapped checks (tested).
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

/**
 * A literal address on the public internet. Anything else (a name, a private, local or reserved range) is refused.
 * Node's BlockList judges an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) by the IPv4 rules: no IPv6 rule for it here,
 * since one would match every IPv4 address too.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

export class FeedAddressError extends Error {
  readonly code = "EFEEDADDR";
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * The `lookup` given to `https.request`: the connection goes to an address this check saw, so a second DNS answer
 * (rebinding) cannot change it. One non-public address among the answers refuses the whole name.
 */
export function guardedLookup(resolve: Resolver, allowed: (address: string) => boolean = isPublicAddress) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      const usable = addresses.filter(
        (entry) => options.family === undefined || options.family === 0 || entry.family === options.family,
      );
      const first = usable[0];
      if (!first || addresses.some((entry) => !allowed(entry.address)))
        return callback(new FeedAddressError("feed address refused"), "");
      if (options.all) return callback(null, usable);
      return callback(null, first.address, first.family);
    });
  };
}

/** The URL is fetched only when https, without credentials, and not a literal non-public address (no lookup runs for those). */
export function feedUrlRefusal(
  url: URL,
  allowed: (address: string) => boolean = isPublicAddress,
): string | null {
  if (url.protocol !== "https:") return "not_https";
  if (url.username !== "" || url.password !== "") return "credentials";
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") return "no_host";
  if (isIP(host) !== 0 && !allowed(host)) return "address";
  return null;
}

export const FEED_MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The next URL of a redirect, judged like the first; null when the answer is not a redirect. */
export function redirectTarget(
  current: URL,
  status: number,
  location: string | undefined,
  allowed: (address: string) => boolean = isPublicAddress,
): { url: URL } | { refused: string } | null {
  if (!REDIRECTS.has(status)) return null;
  if (location === undefined || location.length > 2048) return { refused: "bad_redirect" };
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return { refused: "bad_redirect" };
  }
  const refusal = feedUrlRefusal(next, allowed);
  return refusal === null ? { url: next } : { refused: refusal };
}
