import type { TrustRefusal } from "@pap/contracts";
import { within } from "../policy/target-path.ts";

/** M7R104, W5-R27: why trusting `folder` (a real path) would trust too much, or null. Every path here is real (symlinks resolved). */
export function trustRefusal(
  folder: string,
  facts: {
    readonly home: string;
    readonly agentDir: string;
    readonly papHome: string;
    /** Real path of `<papHome>/agents` (the joined path when it does not exist yet). */
    readonly agents: string;
    readonly projects: readonly string[];
  },
): TrustRefusal | null {
  if (folder === "/") return "filesystem-root";
  if (within(folder, facts.home)) return "home-or-above";
  if (within(folder, facts.agentDir) || within(folder, facts.papHome)) return "holds-pi-or-pap";
  // W5-R27 (amended): nothing inside `<papHome>/agents` (agent homes and `.runs`). An agent writes its own home, so
  // trusting it would load agent-written `.pi/` and `.agents/` project resources; the profile and the role are how an
  // agent is configured. Lane worktrees under `<papHome>/worktrees` need trust (M9): not refused here.
  if (within(facts.agents, folder)) return "inside-pap-home";
  if (facts.projects.some((project) => project !== folder && within(folder, project)))
    return "holds-other-projects";
  return null;
}
