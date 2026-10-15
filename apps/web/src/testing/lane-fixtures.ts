import type { FanoutView, LaneView } from "@pap/contracts";

/** A quiet active lane (no setup, no PR); `id` also names its worktree and branch. */
export const laneView = (patch: Partial<LaneView> & { id: string }): LaneView => ({
  projectRoot: "/w/proj",
  worktree: `/p/worktrees/${patch.id}`,
  title: patch.id,
  branch: `pi/${patch.id}`,
  baseRef: "refs/heads/main",
  baseLabel: "main",
  primarySessionId: null,
  createdBy: "session",
  state: "active",
  failedReason: null,
  setup: { state: "ok", exitCode: 0, startedAt: 1, finishedAt: 2 },
  tests: { state: "none", exitCode: null, finishedAt: null },
  facts: null,
  pr: null,
  forge: null,
  remote: null,
  pushRemote: null,
  source: { kind: "description" },
  model: null,
  fanoutId: null,
  fanoutSlot: null,
  firstRunEndedAt: null,
  checkpointsFull: false,
  descriptionPreview: "",
  descriptionTruncated: false,
  notices: [],
  archivedAt: null,
  createdAt: 1,
  ...patch,
});

export const fanoutView = (patch: Partial<FanoutView> & { id: string }): FanoutView => ({
  prompt: "p",
  createdAt: 1,
  laneIds: ["a-1a2b", "b-1a2b"],
  ...patch,
});

export const laneSnapshot = (lanes: LaneView[], fanouts: FanoutView[] = [], archived = 0) => ({
  kind: "snapshot",
  lanes,
  fanouts,
  archived,
  truncated: false,
});
