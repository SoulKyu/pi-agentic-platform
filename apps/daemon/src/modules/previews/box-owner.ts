import type { BoxRef } from "@pap/contracts";

/** Who owns a box: a project box's owner or an agent's, from the daemon's own records; null for a box nobody owns. */
export function createBoxOwner(sources: {
  project(projectId: string): string | null;
  agent(agentId: string): string | null;
}): (box: BoxRef) => string | null {
  return (box) => (box.kind === "project" ? sources.project(box.id) : sources.agent(box.id));
}
