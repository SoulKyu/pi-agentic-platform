import type { AgentSummary, SessionStatus, VM_PHASES } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";

/**
 * The one vocabulary of an agent's state (header pill, composer notice, status panel, rail words). `ready` is not in
 * it: an agent that is on and has nothing to say shows no badge, so the derivation answers null for it.
 */
export const LIFECYCLES = [
  "working",
  "needs_input",
  "waking",
  "paused",
  "parked",
  "failed",
  "quarantined",
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export type SessionWord = SessionStatus;
export type VmPhase = (typeof VM_PHASES)[number];

/** DESIGN §9.1 roles: agent violet for work, attention for a wait, muted for a delay or a rest, error for a fault. */
export const LIFECYCLE_TONE: Readonly<Record<Lifecycle, ChipTone>> = {
  working: "run",
  needs_input: "att",
  waking: "mut",
  paused: "mut",
  parked: "mut",
  failed: "err",
  quarantined: "err",
};

/** The composer says only what asks for an action or explains a delay, never that all is well. */
export const COMPOSER_LIFECYCLES: ReadonlySet<Lifecycle> = new Set(["waking", "needs_input", "paused"]);

/** What a VM phase says on its own (a display mapping: pap-vmd keeps its own names). */
export function vmPhaseLifecycle(phase: VmPhase): Lifecycle | null {
  switch (phase) {
    case "stopped":
    case "stopping":
      return "parked";
    case "starting":
      return "waking";
    case "paused":
      return "paused";
    case "running":
      return null;
  }
}

/**
 * The agent's lifecycle from its summary, its thread's session status and its VM phase (each null when unknown, or in
 * host mode). Faults first, then the owner's own pause, then what waits for the owner, then motion, then rest.
 */
export function agentLifecycle(
  agent: Pick<AgentSummary, "state" | "paused" | "quarantined">,
  session: SessionWord | null,
  vm: VmPhase | null,
): Lifecycle | null {
  if (agent.quarantined || agent.state === "quarantined") return "quarantined";
  if (agent.state === "failed") return "failed";
  if (agent.paused || agent.state === "paused" || vm === "paused") return "paused";
  if (agent.state === "needs_input") return "needs_input";
  if (agent.state === "running" || session === "running") return "working";
  if (session === "starting" || vm === "starting") return "waking";
  if (session === "cold" || session === "releasing" || vm === "stopped" || vm === "stopping") return "parked";
  return null;
}
