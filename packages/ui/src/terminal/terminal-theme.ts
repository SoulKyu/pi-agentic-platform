import type { ITheme } from "@xterm/xterm";

/** Reads one pap token (`bg`, not `--bg`) where the terminal sits. */
export type TokenReader = (name: string) => string;

/** The token each ANSI colour takes (DESIGN §9.2); the bright variants take the same. 256-colour and truecolor pass through. */
const ANSI_TOKENS = {
  black: "text-dim",
  red: "err",
  green: "ok",
  yellow: "you",
  blue: "agent",
  magenta: "attn",
  cyan: "agent",
  white: "text",
} as const;

export function terminalTheme(read: TokenReader): ITheme {
  const theme: Record<string, string> = {
    background: read("bg"),
    foreground: read("text"),
    cursor: read("you-fill"),
    cursorAccent: read("bg"),
    selectionBackground: read("surface-2"),
  };
  for (const [name, token] of Object.entries(ANSI_TOKENS)) {
    theme[name] = read(token);
    theme[`bright${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`] = read(token);
  }
  return theme as ITheme;
}

/** The tokens as the browser computes them on `element`: a theme switch changes them, and the caller reads again. */
export function tokenReader(element: Element): TokenReader {
  const style = getComputedStyle(element);
  return (name) => style.getPropertyValue(`--${name}`).trim();
}
