import type { MessageKey, Translate } from "../../i18n/index.ts";
import type { Chord, Platform } from "./keys.ts";

export type KeyNames = Readonly<
  Record<
    | "ctrl"
    | "alt"
    | "shift"
    | "meta"
    | "escape"
    | "enter"
    | "space"
    | "tab"
    | "backspace"
    | "delete"
    | "up"
    | "down"
    | "left"
    | "right"
    | "home"
    | "end"
    | "pageup"
    | "pagedown",
    string
  >
>;

const MAC_GLYPHS: Readonly<Record<string, string>> = {
  escape: "⎋",
  enter: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};
const NAMED: Readonly<Record<string, keyof KeyNames>> = {
  escape: "escape",
  enter: "enter",
  " ": "space",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

/** Orca: never hard-code metaKey; Apple platforms (iPadOS reports "Macintosh") use ⌘. */
export function detectPlatform(nav: { platform?: string; userAgent?: string } = navigator): Platform {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform ?? "") || /Macintosh|iPhone|iPad/.test(nav.userAgent ?? "")
    ? "mac"
    : "other";
}

function keyLabel(key: string, platform: Platform, names: KeyNames): string {
  const glyph = platform === "mac" && Object.hasOwn(MAC_GLYPHS, key) ? MAC_GLYPHS[key] : undefined;
  if (glyph !== undefined) return glyph;
  const named = Object.hasOwn(NAMED, key) ? NAMED[key] : undefined;
  if (named !== undefined) return names[named];
  return /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : key;
}

export function chordTokens(chord: Chord, platform: Platform, names: KeyNames): string[] {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  const modifiers =
    platform === "mac"
      ? [ctrl && "⌃", chord.alt && "⌥", chord.shift && "⇧", meta && "⌘"]
      : [ctrl && names.ctrl, chord.alt && names.alt, chord.shift && names.shift, meta && names.meta];
  return [
    ...modifiers.filter((m): m is string => typeof m === "string"),
    keyLabel(chord.key, platform, names),
  ];
}

export const chordJoiner = (platform: Platform): "" | "+" => (platform === "mac" ? "" : "+");

const KEY_NAME_KEYS = {
  ctrl: "commands.key.ctrl",
  alt: "commands.key.alt",
  shift: "commands.key.shift",
  meta: "commands.key.meta",
  escape: "commands.key.escape",
  enter: "commands.key.enter",
  space: "commands.key.space",
  tab: "commands.key.tab",
  backspace: "commands.key.backspace",
  delete: "commands.key.delete",
  up: "commands.key.up",
  down: "commands.key.down",
  left: "commands.key.left",
  right: "commands.key.right",
  home: "commands.key.home",
  end: "commands.key.end",
  pageup: "commands.key.pageup",
  pagedown: "commands.key.pagedown",
} as const satisfies Readonly<Record<keyof KeyNames, MessageKey>>;

/** The key names in the current language (`commands.key.*`), for chordTokens. Consumed by Tasks 17b, 22 and 27. */
export function keyNames(t: Translate): KeyNames {
  return Object.fromEntries(Object.entries(KEY_NAME_KEYS).map(([id, key]) => [id, t(key)])) as KeyNames;
}

const ARIA_NAMES: Readonly<Record<string, string>> = {
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
};
const ariaName = (key: string) =>
  Object.hasOwn(ARIA_NAMES, key) ? (ARIA_NAMES[key] as string) : key.charAt(0).toUpperCase() + key.slice(1);

/** ARIA's aria-keyshortcuts form ("Control+K", "Meta+K"). */
export function ariaKeyShortcuts(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  const key =
    chord.key === " " ? "Space" : chord.key.length === 1 ? chord.key.toUpperCase() : ariaName(chord.key);
  return [ctrl && "Control", chord.alt && "Alt", chord.shift && "Shift", meta && "Meta", key]
    .filter(Boolean)
    .join("+");
}
