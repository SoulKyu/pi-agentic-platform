import type { ITheme } from "@xterm/xterm";
import { mixHex, withAlpha } from "./ansi-palette.ts";

/** Reads one pap token (`bg`, not `--bg`) where the terminal sits. */
export type TokenReader = (name: string) => string;

/** The token each base ANSI colour takes (DESIGN §9.2); cyan and white have no role and are built below (R11). 256-colour and truecolor pass through. */
const ANSI_TOKENS = {
  black: "text-muted",
  red: "err",
  green: "ok",
  yellow: "you",
  blue: "agent",
  magenta: "attn",
} as const;

const BRIGHT_TOWARD_TEXT = 0.35;
const SELECTION_ALPHA = 0x59; // 35 %

const brightName = (name: string) => `bright${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;

export function terminalTheme(read: TokenReader): ITheme {
  const text = read("text");
  const theme: Record<string, string> = {
    background: read("bg"),
    foreground: text,
    cursor: read("you-fill"),
    cursorAccent: read("bg"),
    selectionBackground: withAlpha(read("agent"), SELECTION_ALPHA),
  };
  const base: Record<string, string> = {
    cyan: mixHex(read("agent"), read("ok"), 0.5),
    white: mixHex(text, read("text-muted"), BRIGHT_TOWARD_TEXT),
  };
  for (const [name, token] of Object.entries(ANSI_TOKENS)) base[name] = read(token);
  for (const [name, colour] of Object.entries(base)) {
    theme[name] = colour;
    theme[brightName(name)] = name === "white" ? text : mixHex(colour, text, BRIGHT_TOWARD_TEXT);
  }
  return theme as ITheme;
}

/** The tokens as the browser computes them on `element`: a theme switch changes them, and the caller reads again. */
export function tokenReader(element: Element): TokenReader {
  const style = getComputedStyle(element);
  return (name) => style.getPropertyValue(`--${name}`).trim();
}
