import { stripHidden } from "../../lib/untrusted-text.ts";

const MAX_BYTES = 16 * 1024;
const PROMPT = /^\s*[$#] /;

type ShellText = { readonly text: string } | { readonly refused: "too_long" | "empty" };

/**
 * What TO TERMINAL types for a fenced block. Hidden characters go first (no CR presses Enter, no ESC ends a bracketed
 * paste); a console block keeps its prompt lines only; the block loses its blank edges, so no final new line is typed.
 */
export function shellText(code: string, lang: string): ShellText {
  let lines = stripHidden(code).split("\n");
  if (lang.toLowerCase() === "console" && lines.some((line) => PROMPT.test(line))) {
    lines = lines.filter((line) => PROMPT.test(line)).map((line) => line.replace(PROMPT, ""));
  }
  const text = lines
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  if (text.trim() === "") return { refused: "empty" };
  if (new TextEncoder().encode(text).length > MAX_BYTES) return { refused: "too_long" };
  return { text };
}
