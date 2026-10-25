const channels = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const byte = (value: number): string => Math.round(value).toString(16).padStart(2, "0");

/** `a` moved `t` (0 to 1) toward `b`, both `#rrggbb`. */
export function mixHex(a: string, b: string, t: number): string {
  const [from, to] = [channels(a), channels(b)];
  return `#${from.map((c, i) => byte(c + ((to[i] ?? c) - c) * t)).join("")}`;
}

/** `#rrggbb` with an alpha byte (0 to 255) appended: `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${byte(alpha)}`;
}
