import { AGENT_INPUT_KEYS, AgentInput, type Caller, widensReach } from "@pap/contracts";

/** What the step-up on a widening edit reads: the password check, and the owner's host list (W5-R36). */
export interface ReachDeps {
  /** The auth module's password step-up: throws `step_up_required`. */
  requireStepUp(caller: Caller, now: number): void;
  /** The owner's host list now (Settings, Approvals): null is no list, so no host for a shell (W5-R64 I2). Absent: not known, so an own list widens. */
  ownerHosts?(ownerId: string): readonly string[] | null | undefined;
}

/** Asks for the password when `after` lets the agent run more, or more widely, than `before` (M11R44, W5-R36). */
export function stepUpIfWider(
  deps: ReachDeps,
  caller: Caller,
  before: AgentInput | null,
  after: AgentInput,
  now: number,
): void {
  if (widensReach(before, after, deps.ownerHosts?.(caller.userId))) deps.requireStepUp(caller, now);
}

const FIELDS = AGENT_INPUT_KEYS;
/** The names of the fields that differ from `before` (the defaults for a new agent, whose `name` always counts). */
export function changedFields(before: AgentInput | null, after: AgentInput): string[] {
  const was = before ?? AgentInput.parse({ name: after.name });
  return FIELDS.filter(
    (key) => (before === null && key === "name") || JSON.stringify(was[key]) !== JSON.stringify(after[key]),
  );
}
