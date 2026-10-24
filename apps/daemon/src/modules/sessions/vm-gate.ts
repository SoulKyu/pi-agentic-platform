import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentId, PapError } from "@pap/contracts";
import type { AgentGateDeps, AgentLaunch } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";

/** The two file system calls the gate makes: a unit test records them. */
export interface VmGateFs {
  /** `lstat`: the entry itself, never what a link points to; null when there is none. */
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number } | null;
  mkdir(path: string, mode: number): void;
}

export const realFs: VmGateFs = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  mkdir: (path, mode) => mkdirSync(path, { mode }),
};

/** A folder of the daemon's user, not a link; made 0700 when missing. Anything else is `invalid_cwd`. */
export function privateFolder(fs: VmGateFs, path: string): void {
  const found = fs.lstat(path);
  if (found === null) return fs.mkdir(path, 0o700);
  if (found.isSymbolicLink() || !found.isDirectory() || found.uid !== process.getuid?.())
    throw new PapError("invalid_cwd");
}

/**
 * The launch gate of a session that runs in a VM (T8a, R11, R15, RT-08): in place of the host gate's sandbox probe, host
 * home, sandbox spec, vault, one-use values and egress. It answers the agent profile, the role and `vm: true`, and makes
 * `$PAP_HOME/agents/.mirrors/<agent id>/` (the session files' mirrors, 0700), refusing a link or a file there. The agent's host
 * home is never opened: after migration it is empty, and nothing in a VM reads it.
 */
export async function vmGate(
  row: SessionRow,
  deps: Pick<AgentGateDeps, "papHome" | "logger" | "profileOf"> & { readonly fs?: VmGateFs },
): Promise<AgentLaunch> {
  const { agentId, agentRole } = row;
  if (agentId === undefined || agentRole === undefined || !AgentId.safeParse(agentId).success)
    throw new PapError("bad_request");
  const profile = deps.profileOf(row.ownerId, agentId);
  if (profile === null) throw new PapError("not_found");
  if (profile.quarantined) throw new PapError("agent_paused");
  const fs = deps.fs ?? realFs;
  const agents = join(deps.papHome, "agents");
  const mirrors = join(agents, ".mirrors");
  for (const folder of [agents, mirrors, join(mirrors, agentId)]) privateFolder(fs, folder);
  return await Promise.resolve({
    agent: { id: agentId, name: profile.name, role: profile.input.role },
    role: agentRole,
    input: profile.input,
    vm: true,
  });
}
