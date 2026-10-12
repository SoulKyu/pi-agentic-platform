/**
 * The policy puts a header first in its message (size, lines, hidden characters). The card keeps that line in view and
 * scrolls the rest beneath it, so a long or blank-padded body cannot push the header away (R91). Nothing is dropped or
 * reworded; a message of one line has no header and is all body.
 */
export function splitApproval(message: string | undefined): { header: string | null; body: string } {
  const text = message ?? "";
  const end = text.indexOf("\n");
  return end === -1
    ? { header: null, body: text }
    : { header: text.slice(0, end), body: text.slice(end + 1) };
}
