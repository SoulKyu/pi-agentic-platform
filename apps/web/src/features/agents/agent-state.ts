import type { AgentRailState } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";

/** The chip tone of each state the rail shows (M11R62). */
export const STATE_CHIP: Readonly<Record<AgentRailState, ChipTone>> = {
  needs_input: "att",
  running: "run",
  failed: "err",
  paused: "mut",
  idle: "mut",
  quarantined: "err",
};
