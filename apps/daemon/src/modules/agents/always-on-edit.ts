import { AGENT_INPUT_KEYS, type AgentInput } from "@pap/contracts";

/**
 * R7: an edit that flips `alwaysOn` and nothing else does not ask the live thread worker to go (decision 149). Every other
 * edit keeps M11R47. False when either side has no profile or nothing changed.
 */
export function onlyAlwaysOnChanged(before: AgentInput | null, after: AgentInput | null): boolean {
  if (before === null || after === null) return false;
  const differing = AGENT_INPUT_KEYS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return differing.length === 1 && differing[0] === "alwaysOn";
}
