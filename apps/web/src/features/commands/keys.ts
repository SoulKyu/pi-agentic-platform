import { KEY_NONE } from "@pap/contracts";
import { cancelsComposition } from "@pap/ui";

export type Platform = "mac" | "other";

export interface Chord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
}

export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  getModifierState?(name: string): boolean;
}

type ModifierName = "mod" | "ctrl" | "meta" | "alt" | "shift";
const MODIFIERS: Readonly<Record<string, ModifierName>> = {
  mod: "mod",
  cmd: "meta",
  meta: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};
const ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  space: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  return: "enter",
};
const NAMED = new Set([
  "escape",
  "enter",
  "tab",
  "backspace",
  "delete",
  " ",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "capslock"]);

const MAX_CHORD_LENGTH = 64;

const isPrintable = (key: string) => [...key].length === 1 && key !== " ";
// Own properties only: a stored "constructor" or "__proto__" must not resolve through Object.prototype.
const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

/** Defensive: stored rules and imports are untrusted, so anything malformed (or not even a string) is null, never a throw. */
export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || text.length > MAX_CHORD_LENGTH) return null;
  const raw = text.trim().toLowerCase();
  if (raw === "" || raw === KEY_NONE) return null;
  // A trailing "++" is the plus key (T3: "mod++").
  const parts =
    raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const modifier = own(MODIFIERS, part);
    if (modifier) {
      if (chord[modifier]) return null;
      chord[modifier] = true;
      continue;
    }
    if (chord.key !== "" || part === "") return null;
    const key = own(ALIASES, part) ?? part;
    if (!NAMED.has(key) && !isPrintable(key)) return null;
    chord.key = key;
  }
  // Orca: either Mod or a platform modifier, not both (Mod+Ctrl is Ctrl+Ctrl off Apple platforms).
  if (chord.key === "" || (chord.mod && (chord.ctrl || chord.meta))) return null;
  return chord;
}

function codeKey(code: string): string | null {
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return own(CODE_KEYS, code) ?? null;
}

interface Candidates {
  /** The layout's key, when it is usable for a shortcut. */
  readonly layout: string | null;
  /** The physical key: always for digits and punctuation, for a letter only when the layout key is unusable. */
  readonly physical: string | null;
}

/** A digit or punctuation character: the one kind of layout key whose physical key is preferred. */
const isSymbolKey = (key: string) => [...key].length === 1 && !/^\p{L}$/u.test(key);

/**
 * Null during a composition, for an input method's Process key, for AltGr and for an event without a key. The physical
 * key is used when the layout key is unusable or is itself a digit or punctuation character and the physical key is not a letter (owner R3-7); a usable
 * letter ("m" on AZERTY's Semicolon) or a named key ("End" on a numpad without NumLock) stays.
 */
function candidatesOf(event: KeyInput, platform: Platform): Candidates | null {
  // Chrome's autofill dispatches keydowns without a key.
  if (typeof event.key !== "string") return null;
  if (cancelsComposition(event) || event.key === "Process") return null;
  if (platform === "other" && event.getModifierState?.("AltGraph") === true) return null;
  const layout = event.key === " " ? " " : event.key.toLowerCase();
  const physical = codeKey(typeof event.code === "string" ? event.code : "");
  const unusable = layout === "" || layout === "dead" || layout === "unidentified";
  const nonLatinUnderCommand =
    /^\p{L}$/u.test(layout) && !/^[a-z]$/.test(layout) && (event.ctrlKey || event.metaKey);
  const macComposed =
    platform === "mac" && event.altKey && isPrintable(layout) && !/^[\x20-\x7e]$/.test(layout);
  const layoutUsable = !unusable && !nonLatinUnderCommand && !macComposed;
  return {
    layout: layoutUsable ? layout : null,
    physical:
      physical !== null && (!layoutUsable || (isSymbolKey(layout) && !/^[a-z]$/.test(physical)))
        ? physical
        : null,
  };
}

/** The keys an event can stand for (layout key first). Empty during a composition, for Process, and for AltGr. */
export function keyCandidates(event: KeyInput, platform: Platform): string[] {
  const candidates = candidatesOf(event, platform);
  if (candidates === null) return [];
  return [...new Set([candidates.layout, candidates.physical].filter((key): key is string => key !== null))];
}

const SHIFTED_SYMBOL = /^[^a-z0-9\s]$/u;

export function matchesChord(chord: Chord, event: KeyInput, platform: Platform): boolean {
  const candidates = candidatesOf(event, platform);
  if (candidates === null) return false;
  const byLayout = candidates.layout === chord.key;
  if (!byLayout && candidates.physical !== chord.key) return false;
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== chord.alt) return false;
  // The Shift of a symbol such as "?" belongs to the layout, not to the chord; a match through the physical key
  // needs the exact Shift, so a physical "/" never fires on Shift+/ (M3-RT-28).
  const symbol = byLayout && !chord.shift && SHIFTED_SYMBOL.test(chord.key);
  return symbol || event.shiftKey === chord.shift;
}

/** Canonical identity on one platform: conflicts and reserved chords compare these. */
export function chordId(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  return [ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", meta && "meta", chord.key]
    .filter(Boolean)
    .join("+");
}

/**
 * For the shortcut recorder: the chord an event stands for, written with `mod`; null for a lone modifier. Digits and
 * punctuation are recorded by physical key (owner R3-7): an account binding is shared by devices with other layouts,
 * and AZERTY's Ctrl+1 must not be stored as "mod+&". Letters keep the layout key.
 */
export function chordFromEvent(event: KeyInput, platform: Platform): string | null {
  const candidates = candidatesOf(event, platform);
  if (candidates === null || MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  const key = candidates.physical ?? candidates.layout;
  if (key === null) return null;
  // Both Ctrl and Cmd: `mod` would stand for one of them, so both are written out (the parser refuses mod+ctrl).
  const primary = platform === "mac" ? event.metaKey : event.ctrlKey;
  const secondary = platform === "mac" ? event.ctrlKey : event.metaKey;
  const modifiers =
    primary && secondary
      ? ["ctrl", "meta"]
      : [primary && "mod", secondary && (platform === "mac" ? "ctrl" : "meta")];
  const text = [...modifiers, event.altKey && "alt", event.shiftKey && "shift", key === " " ? "space" : key]
    .filter(Boolean)
    .join("+");
  // The recorder never stores what the parser would refuse (ContextMenu, PrintScreen...).
  return parseChord(text) === null ? null : text;
}
