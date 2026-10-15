import { z } from "zod";
import {
  EntryId,
  LANE_LIMITS,
  LaneCount as Count,
  LaneId,
  laneText as Text,
  LaneTime as Time,
  Oid,
  SessionRef,
} from "./lanes.ts";
import { RepoPath } from "./vcs.ts";

// ---- review (split from lanes.ts from the start: M9-RT-20) ----
export const ReviewScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch") }),
  z.object({ kind: z.literal("turn"), sessionId: SessionRef, userEntryId: EntryId }),
]);
export type ReviewScope = z.infer<typeof ReviewScope>;
export const ReviewFile = z.object({
  path: RepoPath,
  oldPath: RepoPath.nullable(),
  status: z.enum(["A", "M", "D", "R", "C", "T"]),
  additions: Count.nullable(),
  deletions: Count.nullable(),
  binary: z.boolean(),
  /** The to-side blob (or `deleted`): a file is Seen while the stored identity equals it. */
  identity: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|deleted)$/),
});
export const ReviewList = z.object({
  from: z.object({ oid: Oid, label: z.string().max(255) }),
  to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("commit"), oid: Oid, label: z.string().max(255) }),
    z.object({ kind: z.literal("live"), tree: Oid }),
  ]),
  files: z.array(ReviewFile).max(LANE_LIMITS.reviewFiles),
  truncated: z.boolean(),
});
export type ReviewList = z.infer<typeof ReviewList>;
export const ReviewComment = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  path: RepoPath,
  side: z.enum(["after", "before"]),
  line: z.number().int().positive().max(10_000_000),
  excerpt: Text(LANE_LIMITS.excerpt),
  body: Text(LANE_LIMITS.commentBody).refine((body) => body.trim().length > 0, "a comment"),
  createdAt: Time,
  sentAt: Time.nullable(),
  resolvedAt: Time.nullable(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;
/** Seen is a list, never a record keyed by path: a path named `__proto__` stays data (M9R5). */
export const ReviewDoc = z.object({
  seen: z
    .array(z.object({ path: RepoPath, identity: ReviewFile.shape.identity }))
    .max(LANE_LIMITS.reviewFiles),
  comments: z.array(ReviewComment).max(LANE_LIMITS.comments),
});
export type ReviewDoc = z.infer<typeof ReviewDoc>;

export const LaneTurn = z.object({
  index: z.number().int().positive(),
  userEntryId: EntryId,
  preview: z.string().max(LANE_LIMITS.turnPreview),
  from: Oid.nullable(),
  to: z.union([Oid, z.literal("live")]).nullable(),
});
export const CheckpointStatus = z.object({
  /** `entryId: null` is the `root` checkpoint, taken before the session's first message. */
  target: z.object({ entryId: EntryId.nullable(), turn: z.number().int().positive().nullable() }).nullable(),
  exact: z.boolean(),
  differs: z.boolean(),
  undoAvailable: z.boolean(),
});
export const CompareColumn = z.object({
  laneId: LaneId,
  summary: z.string().max(LANE_LIMITS.summary).nullable(),
  files: Count.nullable(),
  additions: Count.nullable(),
  deletions: Count.nullable(),
  durationMs: Count.nullable(),
  /** M10's `RunsPort.sessionCost` of the primary session; null for a lane whose session has had no run. */
  costUsd: z.number().nonnegative().nullable(),
  /** How the primary session's runs are billed (the runs store, M10R86); `subscription` makes the figure API-equivalent, not money spent. Null with no run. */
  billing: z.enum(["api", "subscription", "unknown"]).nullable(),
});
