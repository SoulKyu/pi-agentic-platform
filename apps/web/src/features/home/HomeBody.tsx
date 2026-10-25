import "../../i18n/register-home.ts";
import type { HomeLayout, ProjectSummary } from "@pap/contracts";
import { BoxFact } from "../boxes/BoxFact.tsx";
import { GithubHomeEntry } from "../github/GithubHomeEntry.tsx";
import { KnowledgeRow } from "../knowledge/KnowledgeRow.tsx";
import { useProjectSettingsRequest } from "../../stores/project-settings-request.ts";
import { ActionRow } from "./ActionRow.tsx";
import type { HomeActions, HomeShortcuts } from "./home-actions.ts";
import { RecentWork } from "./RecentWork.tsx";
import { StatusLine } from "./StatusLine.tsx";

export interface HomeBodyProps {
  readonly project: ProjectSummary | null;
  readonly layout: HomeLayout;
  readonly actions: HomeActions;
  readonly shortcuts: HomeShortcuts;
  /** The Launch of this screen is running: the box line's step panel is open without a click. */
  readonly asked?: boolean;
}

/**
 * Under the composer (§3.2–§3.4): the action row, the status line and Recent work, each hidden from Settings ›
 * Appearance › Home (§6). One lazy chunk with the home's catalog, so the initial bundle carries the composer only (§8).
 */
export default function HomeBody({ project, layout, actions, shortcuts, asked }: HomeBodyProps) {
  return (
    <div data-home-body="" className="flex flex-col gap-s5">
      {project?.kind === "box" ? (
        <BoxFact
          project={project}
          opened={asked === true}
          onSettings={(id) => useProjectSettingsRequest.getState().ask(id)}
        />
      ) : null}
      {project?.kind === "box" ? (
        <GithubHomeEntry
          projectId={project.id}
          onOpenSession={(id) => actions.open({ kind: "session", id })}
        />
      ) : null}
      <ActionRow project={project} layout={layout} actions={actions} shortcuts={shortcuts} />
      {layout.status ? <StatusLine project={project} actions={actions} /> : null}
      {project === null ? null : <KnowledgeRow projectId={project.id} />}
      {layout.recent ? <RecentWork project={project} actions={actions} /> : null}
    </div>
  );
}
