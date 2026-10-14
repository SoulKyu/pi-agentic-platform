import { within } from "../policy/target-path.ts";

export type TrustRefusal = "filesystem-root" | "home-or-above" | "holds-pi-or-pap" | "holds-other-projects";

/** M7R104: why trusting `folder` (a real path) would trust too much, or null. Every path here is real (symlinks resolved). */
export function trustRefusal(
  folder: string,
  facts: {
    readonly home: string;
    readonly agentDir: string;
    readonly papHome: string;
    readonly projects: readonly string[];
  },
): TrustRefusal | null {
  if (folder === "/") return "filesystem-root";
  if (within(folder, facts.home)) return "home-or-above";
  if (within(folder, facts.agentDir) || within(folder, facts.papHome)) return "holds-pi-or-pap";
  if (facts.projects.some((project) => project !== folder && within(folder, project)))
    return "holds-other-projects";
  return null;
}
