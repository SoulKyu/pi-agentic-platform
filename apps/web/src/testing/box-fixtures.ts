import type { BoxPhase, ProjectBoxView, ProjectSummary } from "@pap/contracts";
import { shellProject } from "./shell-snapshot.ts";

/** A box project as the shell stream describes it. */
export const boxProject = (phase: BoxPhase, patch: Partial<ProjectSummary> = {}): ProjectSummary =>
  shellProject({
    id: "b1",
    name: "notes",
    root: "/boxes/b1/project",
    kind: "box",
    box: { phase },
    sessions: 2,
    ...patch,
  });

/** What `projects.box` answers. */
export const boxView = (patch: Partial<ProjectBoxView> = {}): ProjectBoxView => ({
  phase: "stopped",
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  hosts: ["api.example.com"],
  packages: { built: ["git"], wanted: null },
  scratch: false,
  counts: { sessions: 3, triggers: 1 },
  ...patch,
});
