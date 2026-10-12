import type { ProjectSummary } from "@pap/contracts";
import { useState } from "react";
import { ProjectMenu, ProjectRename } from "./ProjectMenu.tsx";

interface ProjectHeadingProps {
  readonly id: string;
  readonly name: string;
  /** The project's folder; absent for the group of sessions without a project. */
  readonly root: string | null;
  readonly count: number;
  /** The project itself, for its menu; null for the group of sessions without one. */
  readonly project: ProjectSummary | null;
  /** The projects as the tree shows them, first first. */
  readonly order: readonly ProjectSummary[];
  readonly movable: boolean;
}

/** A project's name (the heading), its folder, how many active sessions it has, and its menu. */
export function ProjectHeading({ id, name, root, count, project, order, movable }: ProjectHeadingProps) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="flex flex-col gap-s1">
      <div className="flex items-baseline justify-between gap-s2">
        {project !== null && renaming ? (
          <>
            {/* The section stays named while its heading is a field. */}
            <h3 id={id} className="sr-only">
              {name}
            </h3>
            <ProjectRename project={project} order={order} onDone={() => setRenaming(false)} />
          </>
        ) : (
          <>
            <h3 id={id} className="min-w-0 break-words text-ui font-semibold">
              {name}
            </h3>
            <span className="flex items-center gap-s1">
              <span className="font-mono text-label text-muted tabular-nums">{count}</span>
              {project === null ? null : (
                <ProjectMenu
                  project={project}
                  order={order}
                  movable={movable}
                  onRename={() => setRenaming(true)}
                />
              )}
            </span>
          </>
        )}
      </div>
      {root === null ? null : <p className="break-all font-mono text-code text-dim">{root}</p>}
    </div>
  );
}
