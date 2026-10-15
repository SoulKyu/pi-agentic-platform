import type { ReviewComment, ReviewDoc, ReviewList } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import { newBed } from "./lanes-bed.tsx";

export const FROM = "1".repeat(40);
export const TO = "2".repeat(40);
export const BLOB = (n: number): string => String(n).repeat(40).slice(0, 40);

export const reviewFile = (path: string, patch: Partial<ReviewFile> = {}): ReviewFile => ({
  path,
  oldPath: null,
  status: "M",
  additions: 3,
  deletions: 1,
  binary: false,
  identity: BLOB(4),
  ...patch,
});

export const reviewList = (files: ReviewFile[], patch: Partial<ReviewList> = {}): ReviewList => ({
  from: { oid: FROM, label: "main" },
  to: { kind: "live", tree: TO },
  files,
  truncated: false,
  ...patch,
});

export const reviewComment = (id: string, patch: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  path: "src/a.ts",
  side: "after",
  line: 2,
  excerpt: "two",
  body: `body ${id}`,
  createdAt: 1,
  sentAt: null,
  resolvedAt: null,
  ...patch,
});

/** The daemon's side of the review: a list, per-file texts and a review document with compare-and-set. */
export function reviewBed(
  files: ReviewFile[],
  options: {
    doc?: ReviewDoc;
    texts?: Record<string, object>;
    turns?: object[];
    list?: Partial<ReviewList>;
  } = {},
) {
  const bed = newBed();
  const server = { doc: options.doc ?? { seen: [], comments: [] }, revision: 1 };
  bed.handlers["lanes.review"] = () => reviewList(files, options.list);
  bed.handlers["lanes.turns"] = () => ({ turns: options.turns ?? [], truncated: false });
  bed.handlers["lanes.reviewState.get"] = () => ({ doc: server.doc, revision: server.revision });
  bed.handlers["lanes.reviewState.set"] = (params) => {
    const asked = params as { doc: ReviewDoc };
    server.doc = asked.doc;
    server.revision += 1;
    return { revision: server.revision };
  };
  bed.handlers["vcs.fileDiff"] = (params) => {
    const { path } = params as { path: string };
    return (
      options.texts?.[path] ?? {
        before: "one\ntwo\nthree",
        after: "one\nTWO\nthree",
        binary: false,
        truncated: false,
      }
    );
  };
  return { bed, server };
}

/** CodeMirror has its own tests (@pap/ui); here the view is a probe that hands back what the pane gave it. */
export const mockReviewDiffView = async () => {
  const { createElement } = await import("react");
  return {
    languageFor: () => null,
    ReviewDiffView: (props: {
      before: string;
      after: string;
      comments: readonly { id: string; heading: string; body: string }[];
      editing?: { line: number; side: string } | null;
      editor?: unknown;
      onComment(line: number, side: "after" | "before"): void;
      onOpenComment(id: string): void;
    }) =>
      createElement(
        "div",
        { "data-slot": "diff-probe", "data-before": props.before, "data-after": props.after },
        createElement(
          "button",
          { type: "button", onClick: () => props.onComment(2, "after") },
          "probe add after 2",
        ),
        createElement(
          "button",
          { type: "button", onClick: () => props.onComment(1, "before") },
          "probe add before 1",
        ),
        ...props.comments.map((comment) =>
          createElement(
            "button",
            { type: "button", key: comment.id, onClick: () => props.onOpenComment(comment.id) },
            `probe open ${comment.id}: ${comment.heading}`,
          ),
        ),
        props.editing
          ? createElement(
              "div",
              { "data-probe-editor": `${props.editing.line}:${props.editing.side}` },
              props.editor as never,
            )
          : null,
      ),
  };
};
