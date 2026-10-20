/** A line that long without a newline is cut here and logged as a line; the rest of it is dropped up to its newline. */
export const PARTIAL_MAX_CHARS = 16_384;

/**
 * The relay's stderr as lines: split on newlines across chunks, empty lines skipped. A line past `PARTIAL_MAX_CHARS` is passed on
 * cut at the cap and the rest of it is discarded until its newline, so nothing past the cap is kept and no value is ever
 * logged from the middle (only the first characters of a line are logged anyway).
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let partial = "";
  let discarding = false;
  return (chunk) => {
    let text = chunk;
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      discarding = false;
      text = text.slice(newline + 1);
    }
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    if (partial.length > PARTIAL_MAX_CHARS) {
      parts.push(partial.slice(0, PARTIAL_MAX_CHARS));
      partial = "";
      discarding = true;
    }
    for (const line of parts) if (line !== "") onLine(line);
  };
}
