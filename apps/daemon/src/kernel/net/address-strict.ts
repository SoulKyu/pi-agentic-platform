import { isIP } from "node:net";
import { blockedAddress, groupsOf } from "./address.ts";

/** Reserved IPv4 blocks that `blockedAddress` lets through but neither a push endpoint nor an egress target uses. */
const EXTRA_V4: ReadonlyArray<readonly [string, number]> = [
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["192.88.99.0", 24],
];

const numeric = (ip: string): number => ip.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
const prefix = (ip: string, bits: number): number => Math.floor(numeric(ip) / 2 ** (32 - bits));
const dotted = (high: number, low: number): string => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

const extraV4 = (ip: string): boolean =>
  EXTRA_V4.some(([base, bits]) => prefix(ip, bits) === prefix(base, bits));

/** The added ranges only: Teredo, documentation and discard IPv6, the four IPv4 documentation and relay blocks. */
function extraReserved(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return extraV4(bare);
  if (family !== 6) return false;
  const g = groupsOf(bare.toLowerCase());
  if (g === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = [
    g[0] ?? 0,
    g[1] ?? 0,
    g[2] ?? 0,
    g[3] ?? 0,
    g[4] ?? 0,
    g[5] ?? 0,
    g[6] ?? 0,
    g[7] ?? 0,
  ];
  const mapped =
    (g.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) ||
    (g.slice(0, 4).every((group) => group === 0) && g4 === 0xffff && g5 === 0);
  if (mapped) return extraV4(dotted(g6, g7));
  return (
    (g0 === 0x2001 && g1 === 0) || // 2001::/32 Teredo
    (g0 === 0x2001 && g1 === 0xdb8) || // 2001:db8::/32 documentation
    (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) || // 100::/64 discard
    (g0 === 0x2002 && extraV4(dotted(g1, g2))) // 6to4 carrying one of the added IPv4 blocks
  );
}

/**
 * The strict address check of the push sender and the egress proxy (M12R20, M13R14, ADR 0059): `blockedAddress` plus the
 * ranges `automation/net-guard.ts` refuses. The egress tests inject their own `denies`, so their loopback fixtures are unaffected.
 */
export function blockedStrict(ip: string): boolean {
  return blockedAddress(ip) || extraReserved(ip);
}
