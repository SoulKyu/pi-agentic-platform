import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  COMMANDS,
  detectPlatform,
  hasCommand,
  keyNames,
  runCommand,
  useCommand,
  useKeybindingsStore,
} from "../../features/commands/index.ts";
import { pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { reportClientIssue } from "../../lib/report.ts";
import { type PaletteSearch, usePaletteRequest } from "../../stores/palette-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useTasksFeed } from "./use-tasks-feed.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTerminals } from "../../stores/terminal-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { buildPaletteItems } from "./palette-items.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { go } from "./tab-actions.ts";

const loadPalette = () => import("../../features/commands/palette/CommandPalette.tsx");

/** An unknown project id searches every project, and the input says so: the label and the filter agree. */
function searchScope(projectId: string | null, projects: ReadonlyMap<string, { readonly name: string }>) {
  const project = projectId === null ? undefined : projects.get(projectId);
  return project === undefined
    ? { projectId: null, projectName: null }
    : { projectId, projectName: project.name };
}

/** Owns `palette.toggle`. The palette and cmdk are fetched on first open, so none of it is in the initial bundle. */
export function PaletteHost() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState<PaletteSearch | null>(null);
  // A request from the home opens the palette in search mode; a plain ⌘K toggles the usual one.
  useCommand("palette.toggle", () => {
    const asked = usePaletteRequest.getState().take();
    setSearch(asked);
    setOpen((current) => (asked === null ? !current : true));
  });
  const rules = useKeybindingsStore((state) => state.rules);
  const tabs = useWorkspaceStore((state) => state.ws.tabs);
  const held = useShellStore((state) => state.view.sessions);
  const views = useViewLabels((state) => state.labels);
  const laneView = useLaneStore((state) => state.view);
  const terminals = useTerminals();
  // The stream opens with the palette and closes with it; the store keeps its last snapshot (RT-31).
  const searchOnly = search !== null;
  useTasksFeed(open && !searchOnly);
  const triggers = useTasksStore((state) => state.view.triggers);
  const projects = useShellStore((state) => state.view.projects);
  const stored = useCurrentProject((state) => state.projectId);
  const newTriggerProject =
    stored !== null && projects.has(stored) ? stored : ([...projects.keys()][0] ?? null);

  const items = useMemo(
    () =>
      open && !searchOnly
        ? buildPaletteItems({
            commands: COMMANDS,
            has: hasCommand,
            rules,
            platform: detectPlatform(),
            names: keyNames(t),
            tabs,
            // Archived sessions belong to the Archived shelf and to search; they take no palette slot.
            sessions: [...held.values()].filter((session) => session.archivedAt === null),
            views,
            lanes: laneView,
            laneFacts: held.values(),
            terminals,
            triggers,
            newTriggerProject,
            t,
            navigate: (item) => go(navigate, pathOfItem(item)),
            run: (id) => {
              try {
                runCommand(id);
              } catch {
                reportClientIssue("command_failed");
              }
            },
          })
        : [],
    [
      open,
      searchOnly,
      rules,
      tabs,
      held,
      views,
      laneView,
      terminals,
      triggers,
      newTriggerProject,
      t,
      navigate,
    ],
  );
  return (
    <LazyPanel
      text={lazyText}
      load={loadPalette}
      open={open}
      props={{
        open,
        onOpenChange: (next: boolean) => {
          setOpen(next);
          if (!next) setSearch(null);
        },
        items,
        openSession: (id) => go(navigate, pathOfItem({ kind: "session", id })),
        search: search === null ? null : searchScope(search.projectId, projects),
      }}
      onFailed={() => setOpen(false)}
    />
  );
}
