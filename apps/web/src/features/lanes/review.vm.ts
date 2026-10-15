import { LANE_LIMITS, type ReviewComment, type ReviewDoc } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import type { MessageKey } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";

export const STATUS_KEYS = {
  A: "lanes.review.status.A",
  M: "lanes.review.status.M",
  D: "lanes.review.status.D",
  R: "lanes.review.status.R",
  C: "lanes.review.status.C",
  T: "lanes.review.status.T",
} as const satisfies Record<ReviewFile["status"], MessageKey>;

/** By path, in code-unit order: the same order on every device. */
export const orderFiles = (files: readonly ReviewFile[]): ReviewFile[] =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** A file is Seen while the stored identity (its to-side blob) is the one it has now. */
export const isSeen = (doc: ReviewDoc, file: Pick<ReviewFile, "path" | "identity">): boolean =>
  doc.seen.some((entry) => entry.path === file.path && entry.identity === file.identity);

export const progressOf = (doc: ReviewDoc, files: readonly ReviewFile[]) => ({
  seen: files.filter((file) => isSeen(doc, file)).length,
  total: files.length,
  comments: doc.comments.filter((comment) => comment.resolvedAt === null).length,
});

export function setSeen(
  doc: ReviewDoc,
  file: Pick<ReviewFile, "path" | "identity">,
  seen: boolean,
): ReviewDoc {
  const others = doc.seen.filter((entry) => entry.path !== file.path);
  if (!seen) return { ...doc, seen: others };
  // The list is lane-wide: past the cap the oldest entries (of files long gone) make room.
  const next = [...others, { path: file.path, identity: file.identity }];
  return { ...doc, seen: next.slice(-LANE_LIMITS.reviewFiles) };
}

/** A turn's preview as visible text (the words around it come from the catalog). */
export const turnPreview = (turn: { readonly preview: string }): string => escapeHidden(turn.preview);

const NO_NUL = (text: string): string => text.replaceAll("\0", "");

export function addComment(doc: ReviewDoc, comment: ReviewComment): ReviewDoc {
  if (doc.comments.length >= LANE_LIMITS.comments) return doc;
  return { ...doc, comments: [...doc.comments, { ...comment, body: NO_NUL(comment.body) }] };
}

const change = (doc: ReviewDoc, id: string, edit: (comment: ReviewComment) => ReviewComment): ReviewDoc =>
  doc.comments.some((comment) => comment.id === id)
    ? { ...doc, comments: doc.comments.map((comment) => (comment.id === id ? edit(comment) : comment)) }
    : doc;

/** An edited comment is new to the agent again: `sentAt` is cleared (M9R89). */
export const editComment = (doc: ReviewDoc, id: string, body: string): ReviewDoc =>
  change(doc, id, (comment) => ({ ...comment, body: NO_NUL(body), sentAt: null }));

export const resolveComment = (doc: ReviewDoc, id: string, now: number): ReviewDoc =>
  change(doc, id, (comment) => ({ ...comment, resolvedAt: now }));

export const deleteComment = (doc: ReviewDoc, id: string): ReviewDoc => ({
  ...doc,
  comments: doc.comments.filter((comment) => comment.id !== id),
});

export const readyToSend = (doc: { readonly comments: readonly ReviewComment[] }): ReviewComment[] =>
  doc.comments.filter((comment) => comment.sentAt === null && comment.resolvedAt === null);

export const markSent = (doc: ReviewDoc, ids: readonly string[], now: number): ReviewDoc => ({
  ...doc,
  comments: doc.comments.map((comment) => (ids.includes(comment.id) ? { ...comment, sentAt: now } : comment)),
});

/** The commented line's text, as visible text, clipped to the contract's excerpt (M9R89). */
export function excerptOf(text: string, line: number): string {
  const found = text.split("\n")[line - 1];
  if (found === undefined) return "";
  return escapeHidden(found.replace(/\r$/, "")).slice(0, LANE_LIMITS.excerpt);
}
