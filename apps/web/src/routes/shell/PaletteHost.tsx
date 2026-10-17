import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useCommand, useKeybindingsStore } from "../../features/commands/index.ts";
import { pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { type PaletteSearch, usePaletteRequest } from "../../stores/palette-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useTasksFeed } from "./use-tasks-feed.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTerminals } from "../../stores/terminal-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { go } from "./tab-actions.ts";

const loadPalette = () => import("./palette-entry.tsx");

/** An unknown project id searches every project, and the input says so: the label and the filter agree. */
function searchScope(projectId: string | null, projects: ReadonlyMap<string, { readonly name: string }>) {
  const project = projectId === null ? undefined : projects.get(projectId);
  return project === undefined
    ? { projectId: null, projectName: null }
    : { projectId, projectName: project.name };
}

/** Owns `palette.toggle`. The palette and cmdk are fetched on first open, so none of it is in the initial bundle. */
export function PaletteHost() {
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
  const agents = useAgents((view) => view.agents);
  const terminals = useTerminals();
  // The stream opens with the palette and closes with it; the store keeps its last snapshot (RT-31).
  const searchOnly = search !== null;
  useTasksFeed(open && !searchOnly);
  const triggers = useTasksStore((state) => state.view.triggers);
  const projects = useShellStore((state) => state.view.projects);
  const stored = useCurrentProject((state) => state.projectId);
  const newTriggerProject =
    stored !== null && projects.has(stored) ? stored : ([...projects.keys()][0] ?? null);

  const source = useMemo(
    () => ({
      rules,
      tabs,
      sessions: held,
      views,
      lanes: laneView,
      terminals,
      triggers,
      newTriggerProject,
      agents,
    }),
    [rules, tabs, held, views, laneView, terminals, triggers, newTriggerProject, agents],
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
        source,
        openSession: (id) => go(navigate, pathOfItem({ kind: "session", id })),
        search: search === null ? null : searchScope(search.projectId, projects),
      }}
      onFailed={() => setOpen(false)}
    />
  );
}
