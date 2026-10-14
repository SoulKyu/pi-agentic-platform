import { Button } from "@pap/ui";
import { useState } from "react";
import type { ProjectRef } from "../../features/skills/skills.vm.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadSkills = () =>
  import("../../features/skills/SkillsSection.tsx").then((module) => ({ default: module.SkillsSection }));

/**
 * The project the owner came from (M7R118): the one the switcher shows, else the project of the last session tab
 * of the workspace; `null` when neither has one, and installs then default to all projects.
 */
function useCameFromProject(): ProjectRef | null {
  const chosen = useEffectiveProject();
  const tabs = useWorkspaceStore((state) => state.ws.tabs);
  const sessions = useShellStore((state) => state.view.sessions);
  const projects = useShellStore((state) => state.view.projects);
  if (chosen !== null) return { root: chosen.root, name: chosen.name };
  for (const tab of tabs.toReversed()) {
    if (tab.item.kind !== "session") continue;
    const projectId = sessions.get(tab.item.id)?.projectId ?? null;
    const project = projectId === null ? undefined : projects.get(projectId);
    if (project !== undefined) return { root: project.root, name: project.name };
  }
  return null;
}

/** Settings › Skills in a chunk of its own. The password prompt comes from the shell through its step-up context (MC49). */
export function SkillsSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const project = useCameFromProject();
  const { Lazy, attempt, retry } = useRetryableLazy(loadSkills);
  const [failed, setFailed] = useState(false);
  return (
    <LazyBoundary
      resetKey={attempt}
      onError={(error) => {
        setFailed(true);
        notifyLazyFailure(error, failureText);
      }}
      fallback={
        failed ? (
          <div>
            <Button
              onClick={() => {
                setFailed(false);
                retry();
              }}
            >
              {t("settings.skills.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settings.skills.loading")}
          </p>
        )
      }
    >
      <Lazy project={project} />
    </LazyBoundary>
  );
}
