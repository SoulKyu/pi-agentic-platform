import type { HomeActions } from "../../features/home/home-actions.ts";
import { pathOfItem } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { go, type Navigate } from "./tab-actions.ts";

/**
 * What the home opens, in the shell's terms: tabs by their URL, drawers and dialogs by their commands, prefills by
 * their stores. On a phone, the Lists and Inbox sections stand in for the drawers (their commands exist only there).
 */
export function homeActions(navigate: Navigate): HomeActions {
  return {
    href: (target) => pathOfItem(target),
    open: (target) => go(navigate, pathOfItem(target)),
    openTree: () => {
      if (!runCommand("mobile.lists.open")) runCommand("drawer.tree.toggle");
    },
    openInbox: () => {
      if (!runCommand("mobile.inbox.open")) runCommand("drawer.inbox.toggle");
    },
    openSearch: (projectId) => {
      usePaletteRequest.getState().askSearch(projectId);
      if (!runCommand("palette.toggle")) usePaletteRequest.getState().take();
    },
    openShortcuts: () => {
      runCommand("shortcuts.help");
    },
    newLane: (prefill) => {
      useNewLaneRequest.getState().request(prefill);
      if (runCommand("lanes.new")) return true;
      useNewLaneRequest.getState().take();
      return false;
    },
    newTrigger: (projectId, prefill) => {
      useTriggerPrefill.getState().put(projectId, prefill);
      go(navigate, pathOfItem({ kind: "trigger", id: `new:${projectId}` }));
    },
    addProject: (onAdded) => useAddProjectRequest.getState().ask(onAdded),
  };
}
