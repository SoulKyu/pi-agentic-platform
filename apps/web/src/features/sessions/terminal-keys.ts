type KeyEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

const ESC = "\u001b";
const NAMED: Readonly<Record<string, string>> = {
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  Insert: `${ESC}[2~`,
  Delete: `${ESC}[3~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Escape: ESC,
  Backspace: "\u007f",
};
/** Alt+arrow: word moves for left and right, the xterm modified form for up and down. */
const ALT_ARROW: Readonly<Record<string, string>> = {
  ArrowLeft: `${ESC}b`,
  ArrowRight: `${ESC}f`,
  ArrowUp: `${ESC}[1;3A`,
  ArrowDown: `${ESC}[1;3B`,
};

/**
 * What a key press writes to a terminal-style input, or null when the browser should handle it: Meta shortcuts,
 * Ctrl+V (the paste arrives through the input event) and plain characters (the textarea's input event carries
 * them, which is what keeps IME composition whole).
 */
export function terminalKeyData(event: KeyEvent): string | null {
  const { key } = event;
  if (event.metaKey) return null;
  const letter = /^[a-z]$/i.test(key);
  if (event.ctrlKey) {
    if (!letter || key.toLowerCase() === "v") return null;
    const code = String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96);
    return event.altKey ? `${ESC}${code}` : code;
  }
  if (event.altKey) {
    if (ALT_ARROW[key] !== undefined) return ALT_ARROW[key];
    if (key === "Backspace") return `${ESC}\u007f`;
    return key.length === 1 ? `${ESC}${key}` : null;
  }
  if (key === "Enter") return event.shiftKey ? "\n" : "\r";
  if (key === "Tab") return event.shiftKey ? `${ESC}[Z` : "\t";
  return NAMED[key] ?? null;
}
