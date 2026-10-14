import { JsoncError, parseJsonc, scanJsonc, stripBom, stripJsonComments } from "../jsonc.ts";

/** 1-based line and column of an offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/**
 * Why a text is not a models.json Pi would read, or `null` when it is: a position and a fixed phrase, never a piece of
 * the text (the parser's own message can quote a value, so only the offset is taken from it). Columns on a line that
 * holds a comment or a trailing comma are those of the text with those removed.
 */
export function brokenIssues(text: string): string[] | null {
  try {
    for (const token of scanJsonc(text)) {
      if (token.role === "comment" && token.value.startsWith("/*")) {
        const { line, column } = lineColumn(text, token.start);
        return [`line ${line}, column ${column}: block comments are not accepted`];
      }
    }
  } catch (error) {
    if (error instanceof JsoncError) return [error.message];
    throw error;
  }
  try {
    parseJsonc(text);
    return null;
  } catch (error) {
    const offset = /(?:in|after) JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(
      error instanceof Error ? error.message : "",
    )?.[1];
    if (offset === undefined) return ["invalid JSON"];
    const stripped = stripJsonComments(stripBom(text));
    const { line, column } = lineColumn(stripped, Number(offset));
    return [`line ${line}, column ${column}: invalid JSON`];
  }
}
