import "../../i18n/register-home.ts";
import type { HomeLayout, ProjectSummary } from "@pap/contracts";
import { KnowledgeRow } from "../knowledge/KnowledgeRow.tsx";
import { ActionRow } from "./ActionRow.tsx";
import type { HomeActions, HomeShortcuts } from "./home-actions.ts";
import { RecentWork } from "./RecentWork.tsx";
import { StatusLine } from "./StatusLine.tsx";

export interface HomeBodyProps {
  readonly project: ProjectSummary | null;
  readonly layout: HomeLayout;
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
}

/**
 * Under the composer (§3.2–§3.4): the action row, the status line and Recent work, each hidden from Settings ›
 * Appearance › Home (§6). One lazy chunk with the home's catalog, so the initial bundle carries the composer only (§8).
 */
export default function HomeBody({ project, layout, actions, shortcuts }: HomeBodyProps) {
  return (
    <div data-home-body="" className="flex flex-col gap-s4">
      <ActionRow project={project} layout={layout} actions={actions} shortcuts={shortcuts} />
      {layout.status ? <StatusLine project={project} actions={actions} /> : null}
      {project === null ? null : <KnowledgeRow projectId={project.id} />}
      {layout.recent ? <RecentWork project={project} actions={actions} /> : null}
    </div>
  );
}
