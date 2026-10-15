import type { LaneView, ProjectSummary, ShellSession } from "@pap/contracts";
import type { ItemRef } from "../../features/workspace/index.ts";

interface Facts {
  /** The project the switcher shows (already checked against the known projects), or null. */
  readonly switcherId: string | null;
  readonly item: ItemRef | null;
  readonly projects: readonly ProjectSummary[];
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly lanes: ReadonlyMap<string, LaneView>;
}

/** The project a tab belongs to: its session's, its lane's or the folder it shows. */
function projectOfItem({
  item,
  projects,
  sessions,
  lanes,
}: Omit<Facts, "switcherId">): ProjectSummary | null {
  if (item === null) return null;
  const byRoot = (root: string) => projects.find((project) => project.root === root) ?? null;
  switch (item.kind) {
    case "session": {
      const projectId = sessions.get(item.id)?.projectId;
      return projects.find((project) => project.id === projectId) ?? null;
    }
    case "lane": {
      const lane = lanes.get(item.id);
      return lane === undefined ? null : byRoot(lane.projectRoot);
    }
    case "files":
    case "changes":
      return byRoot(item.root);
    default:
      return null;
  }
}

/** M9R95: the switcher's project, else the active tab's. Null: the dialog asks which one. */
export function projectForNewLane(facts: Facts): string | null {
  const switcher = facts.projects.find((project) => project.id === facts.switcherId);
  return (switcher ?? projectOfItem(facts))?.id ?? null;
}
