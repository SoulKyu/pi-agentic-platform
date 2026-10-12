const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A streaming reply's blocks (M4R113): split at blank lines, never inside a code fence (an unclosed one runs to the
 * end). A fence closes on a marker of the same character, at least as long, with nothing after it. One pass, no
 * backtracking. Lines split on LF or CRLF. A line that opens with ```x``` reads as a fence until the message ends
 * (cosmetic: the finished message renders whole).
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    const marker = match?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && (match?.[2] ?? "").trim() === "")
        fence = null;
    } else if (fence === null && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}
