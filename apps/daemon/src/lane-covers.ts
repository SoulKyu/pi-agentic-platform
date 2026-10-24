import { canonical } from "./kernel/fs/boundary.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";

/**
 * What the Pi modules (trust, skills, MCP, models) may be asked about: the owner's host project roots (never a box project's:
 * its files are the VM's and a helper would open the host path of them, boxes B1), and since M9 the
 * owner's own lane folders too (final review I1). A lane's folder is under no project root, so the trust banner of a
 * lane that did not inherit its project's decision could not ask. Another owner's lane is no folder of this owner: it
 * answers `invalid_cwd` like any foreign folder. The comparison is lexical on a clean path, like the projects'.
 */
export function withLaneRoots(
  projects: ProjectsPort,
  laneRoots: (ownerId: string) => readonly string[],
): ProjectsPort {
  return {
    ...projects,
    covers: (ownerId, path) =>
      projects.coversHost(ownerId, path) ||
      (canonical(path) &&
        laneRoots(ownerId).some(
          (root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`),
        )),
  };
}
