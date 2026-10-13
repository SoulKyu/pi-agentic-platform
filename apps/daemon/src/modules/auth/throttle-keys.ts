import { isIP } from "node:net";
import { sha256Hex } from "../../kernel/ids.ts";

const MAX_ADDRESS_LENGTH = 64;

/** The key of one browser session: the hash of its id hash, never the cookie (M5R127). */
export const sessionKey = (cookieValue: string): string =>
  `session:${sha256Hex(sha256Hex(cookieValue)).slice(0, 32)}`;

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail counts for two); null for anything else. */
function groupsOf(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  if (isIP(text) !== 6) return null;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [, a = 0, b = 0, c = 0, d = 0] = tail.map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...fill, ...back].map((group) => Number.parseInt(group, 16));
}

/**
 * The throttle key of a socket address (M5R81): an IPv4 address as is, an IPv4-mapped IPv6 address as its IPv4, any
 * other IPv6 address by its first 64 bits, because one host holds a whole /64. Anything else is kept, cut short.
 */
export function ipKey(address: string): string {
  const groups = groupsOf(address);
  if (!groups) return `ip:${address.slice(0, MAX_ADDRESS_LENGTH)}`;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `ip:${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `ip:${[g0, g1, g2, g3].map((group) => group.toString(16)).join(":")}::/64`;
}
