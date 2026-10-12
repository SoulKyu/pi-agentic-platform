import type { DeviceBrowser, DeviceOs } from "@pap/contracts";

// The stored user agent is already clipped to 256 characters (M1); clipped again so this function is bounded on its own.
const MAX_LENGTH = 256;

// Plain substring tests in a fixed order: Edge and Opera also say Chrome, Chrome also says Safari, iOS also says
// "Mac OS X", Android also says Linux. No regular expression, so no input can make this slow.
const BROWSERS: ReadonlyArray<readonly [DeviceBrowser, readonly string[]]> = [
  ["other", ["OPR/", "Opera"]],
  ["edge", ["Edg/", "EdgA/", "EdgiOS/", "Edge/"]],
  ["firefox", ["Firefox/", "FxiOS/"]],
  ["chrome", ["Chrome/", "CriOS/"]],
  ["safari", ["Safari/"]],
];
const SYSTEMS: ReadonlyArray<readonly [DeviceOs, readonly string[]]> = [
  ["other", ["CrOS"]],
  ["ios", ["iPhone", "iPad", "iPod"]],
  ["android", ["Android"]],
  ["windows", ["Windows"]],
  ["macos", ["Macintosh", "Mac OS X"]],
  ["linux", ["Linux", "X11"]],
];

function firstMatch<T extends string>(
  table: ReadonlyArray<readonly [T, readonly string[]]>,
  text: string,
): T | "other" {
  for (const [label, needles] of table) if (needles.some((needle) => text.includes(needle))) return label;
  return "other";
}

/** Families only, as codes the web translates: the list never shows the raw user agent. */
export function deviceLabel(userAgent: string | null): { browser: DeviceBrowser; os: DeviceOs } {
  const text = (userAgent ?? "").slice(0, MAX_LENGTH);
  return { browser: firstMatch(BROWSERS, text), os: firstMatch(SYSTEMS, text) };
}
