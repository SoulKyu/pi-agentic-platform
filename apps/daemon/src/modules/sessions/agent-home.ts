import { closeSync, constants, fchmodSync, fstatSync, openSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AgentId, PapError } from "@pap/contracts";

const AGENTS = "agents";
const RUNS = ".runs";
// The same shape pi-host's policy accepts for a scratch folder (`target-path.ts`): a task id is a UUID.
const TASK_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<real $PAP_HOME>/agents`: where every agent home and scratch folder lives (the agents module makes them). */
export const agentsFolderOf = (papHome: string): string => join(realpathSync(papHome), AGENTS);

/** Where an agent's home is (or would be): nothing is opened. `not_found` for a string that is no agent id. */
export function agentHomePath(papHome: string, agentId: string): string {
  if (!AgentId.safeParse(agentId).success) throw new PapError("not_found");
  return join(agentsFolderOf(papHome), agentId);
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null; // a missing entry: the open that follows answers `invalid_cwd`
  }
};

/** A directory of the daemon's user, opened without following a link; anything else is `invalid_cwd`. */
function withPrivateDirectory<T>(path: string, use: (fd: number, mode: number) => T): T {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new PapError("invalid_cwd");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new PapError("invalid_cwd");
    return use(fd, stat.mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * The folder an agent's worker gets (M11R51), checked at every start of an agent session: `<real $PAP_HOME>/agents/<id>`,
 * opened without following a link, a directory of the daemon's user. A home replaced by a link (to `~`, to another
 * agent) is refused, never followed. A home the agent opened up itself (`chmod 755` from its shell) is made private
 * again on that same descriptor (RT-21), so the agent cannot lock itself out and the folder never stays readable.
 */
export function agentHomeOf(papHome: string, agentId: string, onRepaired?: () => void): string {
  const home = agentHomePath(papHome, agentId);
  // O_NOFOLLOW judges the last part only: a linked `agents/` folder leads somewhere else, and the worker would refuse it later.
  if (realOrNull(home) !== home) throw new PapError("invalid_cwd");
  withPrivateDirectory(home, (fd, mode) => {
    if ((mode & 0o077) !== 0) {
      fchmodSync(fd, 0o700);
      onRepaired?.();
    }
  });
  return home;
}

/**
 * An isolated task's scratch folder (owner m17, W5-R4): exactly `<agents>/.runs/<agent id>/<task folder>`, a real
 * directory of the daemon's user, no link in the path. Anything else is `invalid_cwd`: it is the folder the shell writes.
 */
export function agentScratchOf(papHome: string, agentId: string, folder: string): string {
  if (!AgentId.safeParse(agentId).success) throw new PapError("not_found");
  const root = join(agentsFolderOf(papHome), RUNS, agentId);
  const parts = relative(root, folder).split(sep);
  if (!folder.startsWith("/") || parts.length !== 1 || !TASK_FOLDER.test(parts[0] ?? ""))
    throw new PapError("invalid_cwd");
  withPrivateDirectory(folder, () => undefined);
  try {
    if (realpathSync(folder) !== folder) throw new PapError("invalid_cwd");
  } catch (error) {
    throw error instanceof PapError ? error : new PapError("invalid_cwd");
  }
  return folder;
}
