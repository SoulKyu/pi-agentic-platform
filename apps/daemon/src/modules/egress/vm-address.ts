import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { AGENT_NET } from "@pap/contracts";
import { dotted, groupsOf, prefix } from "../../kernel/net/address.ts";
import { blockedStrict } from "../../kernel/net/address-strict.ts";

type Address = { readonly v4: string } | { readonly v6: readonly number[] };

/** An address in any spelling (zone dropped, IPv4-mapped IPv6 read as the IPv4), or null when it is not one. */
function addressOf(ip: string): Address | null {
  const bare = ip.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return { v4: bare };
  if (family !== 6) return null;
  const g = groupsOf(bare.toLowerCase());
  if (g === null) return null;
  const mapped = g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff;
  return mapped ? { v4: dotted(g[6] ?? 0, g[7] ?? 0) } : { v6: g };
}

const keyOf = (address: Address): string =>
  "v4" in address ? address.v4 : address.v6.map((group) => group.toString(16)).join(":");

/** One spelling per address (zone dropped, IPv4-mapped read as IPv4, IPv6 as eight hex groups), or null for a non-address. */
export const canonicalAddress = (ip: string): string | null => {
  const address = addressOf(ip);
  return address === null ? null : keyOf(address);
};

const [SUBNET_BASE = "", SUBNET_BITS = "0"] = AGENT_NET.subnet.split("/");
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

const inAgentSubnet = (v4: string): boolean =>
  prefix(v4, Number(SUBNET_BITS)) === prefix(SUBNET_BASE, Number(SUBNET_BITS));
const isPrivate = (address: Address): boolean =>
  "v4" in address
    ? PRIVATE_V4.some(([base, bits]) => prefix(address.v4, bits) === prefix(base, bits))
    : ((address.v6[0] ?? 0) & 0xfe00) === 0xfc00; // fc00::/7

/**
 * The address policy of an agent VM's proxy (spec §3). Always refused, whatever the host list says: every address of the
 * host itself, the pap0 subnet, and what `blockedStrict` refuses that is not a private range (loopback, link-local, CGNAT,
 * multicast, unspecified, reserved). A private range (RFC 1918, ULA) is allowed only for an exact name or an IP entry:
 * through a wildcard it is `private_wildcard`, because someone else's DNS can point a wildcard's subdomains at the LAN.
 */
export function vmAddressRefused(
  ip: string,
  exact: boolean,
  hostAddresses: readonly string[],
): "blocked_address" | "private_wildcard" | null {
  const address = addressOf(ip);
  if (address === null) return "blocked_address";
  const key = keyOf(address);
  if (hostAddresses.some((host) => canonicalAddress(host) === key)) return "blocked_address";
  if ("v4" in address && inAgentSubnet(address.v4)) return "blocked_address";
  if (isPrivate(address)) return exact ? null : "private_wildcard";
  return blockedStrict(ip) ? "blocked_address" : null;
}

/** Every address of every interface of the host, read at each decision (an interface can come and go). */
export const hostAddressesNow = (): string[] =>
  Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address));
