import type { LaneView } from "./lanes.ts";

// ---- derived status (pure; the web derives it, M11 may on the daemon; split from lanes.ts: M9-RT-20) ----
export const LANE_STATUSES = [
  "archived",
  "setup",
  "needs_attention",
  "working",
  "done",
  "in_review",
  "idle",
] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];
export type LaneStatusReason =
  | "input_needed"
  | "setup_failed"
  | "setup_interrupted"
  | "setup_unapproved"
  | "setup_pending"
  | "create_failed";
export interface LaneSessionFacts {
  /** A session whose folder is the lane's worktree or inside it is running. */
  readonly busy: boolean;
  /** One of them waits on a dialog or an approval. */
  readonly needsInput: boolean;
}

/** First match wins (pi-web's order, amended after its Lot A review: a working or merged lane is never stuck red). */
export function deriveLaneStatus(
  lane: Pick<LaneView, "state" | "setup" | "pr">,
  sessions: LaneSessionFacts,
): { readonly status: LaneStatus; readonly reason: LaneStatusReason | null } {
  if (lane.state === "archived" || lane.state === "archiving") return { status: "archived", reason: null };
  if (lane.state === "creating" || lane.setup.state === "running" || lane.setup.state === "queued")
    return { status: "setup", reason: null };
  if (sessions.needsInput) return { status: "needs_attention", reason: "input_needed" };
  if (sessions.busy) return { status: "working", reason: null };
  if (lane.pr?.state === "merged") return { status: "done", reason: null };
  if (lane.pr?.state === "open") return { status: "in_review", reason: null };
  if (lane.state === "failed") return { status: "needs_attention", reason: "create_failed" };
  if (lane.setup.state === "failed") return { status: "needs_attention", reason: "setup_failed" };
  if (lane.setup.state === "interrupted") return { status: "needs_attention", reason: "setup_interrupted" };
  if (lane.setup.state === "unapproved") return { status: "needs_attention", reason: "setup_unapproved" };
  if (lane.setup.state === "pending") return { status: "needs_attention", reason: "setup_pending" };
  return { status: "idle", reason: null };
}
