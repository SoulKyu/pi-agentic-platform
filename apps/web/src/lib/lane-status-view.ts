import type { LaneStatus } from "@pap/contracts";

/** The dot of a lane status: colour means role (agent works, attention waits, you review, ok is done); never alone. */
export const LANE_DOT: Readonly<Record<LaneStatus, string | null>> = {
  archived: null,
  setup: null,
  needs_attention: "bg-attn-fill",
  working: "bg-agent-fill",
  done: "bg-ok",
  in_review: "bg-you-fill",
  idle: null,
};

/** The same statuses as the tab's dot (`OpenTab.status`). */
export const LANE_TAB_STATUS = {
  archived: null,
  setup: null,
  needs_attention: "waiting",
  working: "running",
  done: "done",
  in_review: "review",
  idle: null,
} as const satisfies Readonly<Record<LaneStatus, "running" | "waiting" | "done" | "review" | null>>;
