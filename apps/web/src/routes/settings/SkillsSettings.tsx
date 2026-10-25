import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import type { ProjectRef } from "../../features/skills/skills.vm.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import "../../i18n/register-boxes.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";
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
  // A box project has no skills of its own yet (a helper would open its host path): never the project the page works on.
  if (chosen !== null) return chosen.kind === "box" ? null : { root: chosen.root, name: chosen.name };
  for (const tab of tabs.toReversed()) {
    if (tab.item.kind !== "session") continue;
    const projectId = sessions.get(tab.item.id)?.projectId ?? null;
    const project = projectId === null ? undefined : projects.get(projectId);
    if (project !== undefined && project.kind !== "box") return { root: project.root, name: project.name };
  }
  return null;
}

/** Settings › Skills in a chunk of its own. The password prompt comes from the shell through its step-up context (MC49). */
export function SkillsSettings() {
  const t = useT();
  const cause = usePiCauseText(t);
  const failureText = useLazyFailureText();
  const project = useCameFromProject();
  const inBox = useEffectiveProject()?.kind === "box";
  const { Lazy, attempt, retry } = useRetryableLazy(loadSkills);
  const wait = useWaitStart(attempt);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <WaitSinceProvider value={wait}>
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
              <LoadingLine
                label={t("settings.skills.loading")}
                since={wait.since}
                deferred={false}
                cause={cause}
              />
            )
          }
        >
          <Lazy project={project} />
        </LazyBoundary>
      </WaitSinceProvider>
      {inBox ? (
        <p role="note" className="text-ui text-muted">
          {t("boxes.off")}
        </p>
      ) : null}
    </>
  );
}
