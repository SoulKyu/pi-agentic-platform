import { isIP } from "node:net";

// After the spike's table. Any blocked answer refuses the whole name (anti-rebinding).
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

/** The leading `bits` bits of a dotted IPv4 address. */
export const prefix = (ip: string, bits: number): number =>
  Math.floor(ip.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0) / 2 ** (32 - bits));

export const dotted = (high: number, low: number): string =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/** The eight 16-bit groups of an IPv6 address in any spelling (`::`, a dotted tail), or null when it is not one. */
export function groupsOf(v6: string): number[] | null {
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v6);
  const text = tail
    ? `${v6.slice(0, tail.index)}${((+(tail[1] ?? 0) << 8) | +(tail[2] ?? 0)).toString(16)}:${((+(tail[3] ?? 0) << 8) | +(tail[4] ?? 0)).toString(16)}`
    : v6;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const side = (half: string | undefined): string[] => (half ? half.split(":") : []);
  const [head, rest] = [side(halves[0]), side(halves[1])];
  const filler = halves.length === 2 ? Array<string>(8 - head.length - rest.length).fill("0") : [];
  const groups = [...head, ...filler, ...rest].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

/** True for anything but a public unicast address, and for anything that is not an address at all. */
export function blockedAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => prefix(bare, bits) === prefix(base, bits));
  if (family !== 6) return true;
  const g = groupsOf(bare.toLowerCase());
  if (g === null) return true;
  const [g0, g1, g2, g4, g5, g6, g7] = [
    g[0] ?? 0,
    g[1] ?? 0,
    g[2] ?? 0,
    g[4] ?? 0,
    g[5] ?? 0,
    g[6] ?? 0,
    g[7] ?? 0,
  ];
  if (g.slice(0, 5).every((group) => group === 0)) {
    // ::ffff:a.b.c.d carries an IPv4 address; every other address in ::/96 (`::`, `::1`, `::a.b.c.d`) is refused.
    return g5 === 0xffff ? blockedAddress(dotted(g6, g7)) : true;
  }
  // ::ffff:0:a.b.c.d (SIIT, RFC 6145) carries an IPv4 address the same way.
  if (g.slice(0, 4).every((group) => group === 0) && g4 === 0xffff && g5 === 0)
    return blockedAddress(dotted(g6, g7));
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10, deprecated site-local
    (g0 & 0xff00) === 0xff00 || // ff00::/8
    (g0 === 0x64 && g1 === 0xff9b) || // NAT64: cannot tell what it maps to
    (g0 === 0x2002 && blockedAddress(dotted(g1, g2))) // 6to4 carrying a blocked IPv4 address
  );
}
