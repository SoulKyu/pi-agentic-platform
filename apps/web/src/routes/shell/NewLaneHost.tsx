import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCommand } from "../../features/commands/index.ts";
import { pathOfItem, useWorkspaceStore, activeTab } from "../../features/workspace/index.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { effectiveProjectId, useCurrentProject } from "../../stores/current-project.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { type NewLanePrefill, useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { projectForNewLane } from "./new-lane-project.ts";
import { go } from "./tab-actions.ts";

const loadDialog = () =>
  import("../../features/lanes/NewLaneDialog.tsx").then((m) => ({ default: m.NewLaneDialog }));

/**
 * Owns `lanes.new` (⌘⇧L, the palette entry, a project's menu): both stay hidden until this is mounted. The dialog is
 * fetched on first open and mounted only while open. Creating opens the new lane's tab, or the compare tab of a fan-out.
 */
export function NewLaneHost() {
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const projects = useShellStore((state) => state.view.projects);
  const [open, setOpen] = useState<{ projectId: string | null; prefill: NewLanePrefill | null } | null>(null);
  useCommand("lanes.new", () => {
    const prefill = useNewLaneRequest.getState().take();
    if (projects.size === 0) return false;
    const shell = useShellStore.getState().view;
    const stored = useCurrentProject.getState().projectId;
    const ofPrefill = [...shell.projects.values()].find((project) => project.root === prefill?.projectRoot);
    setOpen({
      prefill: ofPrefill === undefined ? null : prefill,
      projectId:
        ofPrefill?.id ??
        projectForNewLane({
          switcherId: effectiveProjectId(stored, shell.projects),
          item: activeTab(useWorkspaceStore.getState().ws)?.item ?? null,
          projects: [...shell.projects.values()],
          sessions: shell.sessions,
          lanes: useLaneStore.getState().view.lanes,
        }),
    });
    return true;
  });
  return (
    <LazyPanel
      text={lazyText}
      load={loadDialog}
      open={open !== null}
      props={{
        projects: [...projects.values()],
        initialProjectId: open?.projectId ?? null,
        prefill: open?.prefill ?? null,
        onClose: () => setOpen(null),
        onCreated: ({ laneIds, fanoutId }) => {
          const id = laneIds[0];
          if (fanoutId !== null) go(navigate, pathOfItem({ kind: "compare", id: fanoutId }));
          else if (id !== undefined) go(navigate, pathOfItem({ kind: "lane", id }));
        },
      }}
      onFailed={() => setOpen(null)}
    />
  );
}
