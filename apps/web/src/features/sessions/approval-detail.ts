import type { Dialog } from "@pap/contracts";

/**
 * The text of an approval card. The policy puts a header first in its message (size, lines, hidden
 * characters), and the card keeps its first line in view while the rest scrolls: so the question joins
 * that line, and the header is never the part that scrolls away (R91). Nothing is dropped or reworded.
 */
export function approvalDetail(dialog: Pick<Dialog, "title" | "message">): string {
  const message = dialog.message ?? "";
  if (message === "") return dialog.title;
  return `${dialog.title} · ${message}`;
}
