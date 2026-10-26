import { AgentId } from "@pap/contracts";
import { canonical } from "./fs/boundary.ts";

/** Every pap path at or under it is an agent's folder or nothing: it is never a host path (R2). */
export const AGENTS_ROOT = "/agents";

/** Where the daemon finds an agent's folder in its VM and which files it keeps out of sight; bound late by the composition. */
export interface AgentFilesSource {
  /** The folder of the agent's VM (its layout root), or null when the agent is not this owner's (or unknown). */
  guestRootOf(ownerId: string, agentId: string): string | null;
  /** The agent's imported credentials, as paths relative to its home folder. */
  importedOf(agentId: string): readonly string[];
}

/** `/agents/<AgentId>` or below, lexically (no stat, no owner check), else null. */
export function agentOfPath(path: string): { readonly agentId: string; readonly root: string } | null {
  if (!canonical(path)) return null;
  const [top, id] = path.slice(1).split("/");
  if (top !== "agents" || id === undefined || !AgentId.safeParse(id).success) return null;
  return { agentId: id, root: `${AGENTS_ROOT}/${id}` };
}

/** At or under `/agents`, whatever the spelling: what a host path must never be (R2). */
export const underAgents = (path: string): boolean =>
  path === AGENTS_ROOT || path.startsWith(`${AGENTS_ROOT}/`);
