import type { ReviewComment } from "@pap/contracts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { readyToSend } from "./review.vm.ts";

const quote = (body: string): string =>
  body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");

/**
 * The text that goes to the agent (M9R90, pi-web §10, Orca's `formatDiffComment`): one block per unresolved, unsent
 * comment. The body is one quoted line; the path and the excerpt have their hidden characters, line breaks included,
 * written out, so nothing a file contains can start a field of its own. Empty when nothing is left to send.
 */
export function formatReviewBatch(comments: readonly ReviewComment[]): string {
  const ready = readyToSend({ comments });
  if (ready.length === 0) return "";
  const blocks = ready.map((comment) =>
    [
      `File: ${escapeHidden(comment.path)}`,
      `Line: ${comment.line}${comment.side === "before" ? " (removed)" : ""}`,
      `Code: ${escapeHidden(comment.excerpt)}`,
      `User comment: "${quote(comment.body)}"`,
    ].join("\n"),
  );
  return ["Review comments on the current changes:", ...blocks].join("\n\n");
}
