import { lazy, Suspense, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { parseBoxKey, type BoxRef } from "@pap/contracts";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import {
  SplitView,
  useWorkspaceStore,
  type ItemRef,
  type SettingsSection,
} from "../../features/workspace/index.ts";
import { boxOfSession } from "../../features/previews/preview-box.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { HomePane } from "./HomePane.tsx";
import { runCommand } from "../../lib/command-registry.ts";
import { type NewLanePrefill, useNewLaneRequest } from "../../stores/new-lane-request.ts";
import type { Interleave } from "../../stores/thread-interleave.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import type { ThreadSlot } from "../../features/agents/AgentScreen.tsx";
import type { ReviewSlotProps } from "../../features/lanes/LaneBody.tsx";
import { useTasksFeed } from "./use-tasks-feed.ts";
import { LazyPane } from "./LazyPane.tsx";
import type { TasksPaneProps } from "./tasks-pane-entry.tsx";
import type { TriggerPaneProps } from "./trigger-pane-entry.tsx";
import { leaveTerminal, openTerminalInstead } from "./terminal-tab.ts";
import { armedKey, openPreview } from "./preview-tab.ts";
import { openTriggerInstead } from "./trigger-tab.ts";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

// The Settings screen and all its sections are one chunk, fetched when a settings pane first shows.
const loadSettings = () =>
  import("../settings/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen }));

// The session screen is its own chunk too, so what later milestones add to it stays out of the initial bundle. The
// home (the project home's composer) stays eager: the first paint at "/" does not wait for a fetch.
const loadSession = () =>
  import("../../features/sessions/SessionScreen.tsx").then((module) => ({ default: module.SessionScreen }));

// The M8 panes: one chunk and one catalog each, fetched when a pane of that kind first shows (M8R71).
// The files pane comes with the shell's step-up entry (M8R117).
const loadFiles = () => import("./files-pane-entry.tsx").then((m) => ({ default: m.FilesPaneEntry }));
const loadChanges = () =>
  import("../../features/vcs/ChangesPane.tsx").then((m) => ({ default: m.ChangesPane }));
const loadTerminal = () =>
  import("../../features/terminal/TerminalPane.tsx").then((m) => ({ default: m.TerminalPane }));

// The lane tab (Task 13) and the compare tab (Task 22): lazy (M9R59).
const loadLane = () => import("../../features/lanes/LaneScreen.tsx").then((m) => ({ default: m.LaneScreen }));
const loadReview = () =>
  import("../../features/lanes/ReviewPane.tsx").then((m) => ({ default: m.ReviewPane }));
const loadLaneTerminal = () => import("./lane-terminal.tsx").then((m) => ({ default: m.LaneTerminal }));
const loadCompare = () =>
  import("../../features/lanes/CompareScreen.tsx").then((m) => ({ default: m.CompareScreen }));

/** The archived-lanes list lives in the tree: the phone opens its Lists section, the desktop the ⌘B drawer. */
const openArchivedLanes = () => {
  if (!runCommand("mobile.lists.open")) runCommand("drawer.tree.toggle");
};
// The M10 panes: one chunk each, replaced by Tasks 20 and 21 under the same file names. They read the tasks store.
const loadTasks = () => import("./tasks-pane-entry.tsx").then((m) => ({ default: m.TasksPaneEntry }));
const loadTrigger = () => import("./trigger-pane-entry.tsx").then((m) => ({ default: m.TriggerPaneEntry }));
// The agent tab (M11R109): its own chunk; the thread inside it is the session screen, given by `agentThread`.
const loadAgent = () => import("./agent-pane-entry.tsx").then((m) => ({ default: m.AgentPaneEntry }));
// The previews (UX-2): the strip above a box session's composer and the pane, each its own chunk with its own catalog.
const loadStrip = () =>
  import("../../features/previews/PreviewStrip.tsx").then((m) => ({ default: m.PreviewStrip }));
const loadPreview = () =>
  import("../../features/previews/PreviewPane.tsx").then((m) => ({ default: m.PreviewPane }));
const noop = () => {};

/**
 * "Open in Files" from the changes pane: the shell opens the folder's Files pane (features never import each other).
 * The Files pane keeps its tabs to itself, so the file is not preselected there.
 */
const openInFiles = (root: string) => () => useWorkspaceStore.getState().open({ kind: "files", root });

/** The session screen gets the account's tool card detail from here: features do not read each other's stores. */
function SessionPane({
  sessionId,
  agentId,
  beforeComposer,
  header,
  interleave,
}: {
  readonly sessionId: string;
  /** An agent's thread runs in the agent's VM; any other session in its project's box, when it has one. */
  readonly agentId?: string;
  readonly beforeComposer?: ReactNode;
  readonly header?: ReactNode;
  readonly interleave?: Interleave;
}) {
  const toolDetail = useAppearanceStore((state) => state.account.toolDetail);
  const lazyText = useLazyFailureText();
  const projectId = useShellStore((state) => boxOfSession(state.view, sessionId)?.id ?? null);
  const box = useMemo<BoxRef | null>(
    () =>
      agentId !== undefined
        ? { kind: "agent", id: agentId }
        : projectId === null
          ? null
          : { kind: "project", id: projectId },
    [agentId, projectId],
  );
  const strip =
    box === null ? null : (
      <LazyPanel text={lazyText} load={loadStrip} open props={{ box, onOpen: openPreview }} onFailed={noop} />
    );
  return (
    <LazyPane
      load={loadSession}
      props={{
        sessionId,
        toolDetail,
        beforeComposer:
          strip === null ? (
            beforeComposer
          ) : (
            <>
              {strip}
              {beforeComposer}
            </>
          ),
        header,
        interleave,
      }}
    />
  );
}

/** The compare tab opens a lane's tab, and "Run again" opens the new lane dialog with the group's prompt and models. */
const openLane = (id: string) => useWorkspaceStore.getState().open({ kind: "lane", id });
const runAgain = (prefill: NewLanePrefill) => {
  useNewLaneRequest.getState().request(prefill);
  if (!runCommand("lanes.new")) useNewLaneRequest.getState().take();
};

/** The lane tab's panes (M9R63): the chat, the changes and the terminal of the lane's folder, and the splitter. */
const lanePanes = {
  openCompare: (fanoutId: string) => useWorkspaceStore.getState().open({ kind: "compare", id: fanoutId }),
  chat: (sessionId: string, beforeComposer: ReactNode) => (
    <SessionPane key={sessionId} sessionId={sessionId} beforeComposer={beforeComposer} />
  ),
  changes: (root: string) => (
    <LazyPane key={root} load={loadChanges} props={{ root, onOpenFile: openInFiles(root) }} />
  ),
  terminal: (root: string) => <LazyPane key={root} load={loadLaneTerminal} props={{ root }} />,
  review: (props: ReviewSlotProps) => (
    <LazyPane
      key={props.laneId}
      load={loadReview}
      props={{ ...props, onOpenFile: openInFiles(props.worktree) }}
    />
  ),
  split: (props: ComponentProps<typeof SplitView>) => <SplitView {...props} />,
};
const openSession = (sessionId: string) =>
  useWorkspaceStore.getState().open({ kind: "session", id: sessionId });
const openTrigger = (id: string) => useWorkspaceStore.getState().open({ kind: "trigger", id });
const openTasks = () => useWorkspaceStore.getState().open({ kind: "tasks" });

/** The board and the editor reach a session or a trigger through these (features never import each other). */
const TASKS_CALLBACKS: Omit<TasksPaneProps, "avatarStyle"> = {
  onOpenSession: openSession,
  onOpenTrigger: openTrigger,
  onNewTrigger: (projectId) => openTrigger(`new:${projectId}`),
  onOpenAgent: (agentId) => useWorkspaceStore.getState().open({ kind: "agent", id: agentId }),
};

/** The `tasks` stream is open while a Tasks pane is mounted, whatever file Tasks 20 puts behind it (RT-31). */
function TasksPane() {
  useTasksFeed(true);

  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  return <LazyPane load={loadTasks} props={{ ...TASKS_CALLBACKS, avatarStyle }} />;
}

function TriggerPane({ triggerId }: { readonly triggerId: string }) {
  useTasksFeed(true);
  // The home's Trigger launch leaves a name and a prompt for a new trigger: read once (peek is pure, StrictMode calls an
  // initializer twice), then dropped.
  const projectId = triggerId.startsWith("new:") ? triggerId.slice("new:".length) : null;
  const waiting = useTriggerPrefill((state) => (projectId === null ? null : state.peek(projectId)));
  const [held, setHeld] = useState({ prefill: waiting, launches: 0 });
  // A second Trigger launch while this pane is open: the editor starts again from it (its draft is read once).
  if (waiting !== null && waiting !== held.prefill)
    setHeld({ prefill: waiting, launches: held.launches + 1 });
  useEffect(() => {
    if (projectId !== null && waiting !== null) useTriggerPrefill.getState().drop(projectId);
  }, [projectId, waiting]);
  const props: TriggerPaneProps = {
    triggerId,
    prefill: held.prefill,
    onOpenSession: openSession,
    onOpenTasks: openTasks,
    onCreated: (id) => openTriggerInstead(triggerId, id),
  };
  return <LazyPane key={held.launches} load={loadTrigger} props={props} />;
}

/** The agent's thread is the session screen, with the agent's header, its request cards and the cards among the rows. */
const agentThread = (agentId: string, { sessionId, header, beforeComposer, interleave }: ThreadSlot) => (
  <SessionPane
    key={sessionId}
    sessionId={sessionId}
    agentId={agentId}
    header={header}
    beforeComposer={beforeComposer}
    interleave={interleave}
  />
);
const openAgentSettings = () => useWorkspaceStore.getState().open({ kind: "settings", section: "agents" });

/** The agent tab gets the account's avatar style and event card choice, and mounts the thread's session screen. */
function AgentTab({ agentId }: { readonly agentId: string }) {
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const eventCards = useAppearanceStore((state) => state.account.eventCards);
  const statusPanel = useAppearanceStore((state) => state.account.statusPanel);
  return (
    <LazyPane
      load={loadAgent}
      props={{
        agentId,
        avatarStyle,
        eventCards,
        statusPanel,
        thread: (slot: ThreadSlot) => agentThread(agentId, slot),
        onOpenSettings: openAgentSettings,
        onOpenSession: openSession,
        onOpenTrigger: openTrigger,
      }}
    />
  );
}

/**
 * A preview item's pane. It mounts armed only when the owner's own click opened it (UX2-R77): a pane restored with the
 * workspace, or remounted by a rearranged split, loads nothing until its OPEN PREVIEW is clicked. The click's mark is
 * dropped when the pane goes away.
 */
function PreviewTab({ box: key, name }: { readonly box: string; readonly name: string }) {
  const armed = usePreviewsStore((state) => state.armed.has(armedKey({ kind: "preview", box: key, name })));
  const box = useMemo(() => parseBoxKey(key), [key]);
  useEffect(
    () => () => usePreviewsStore.getState().disarm(armedKey({ kind: "preview", box: key, name })),
    [key, name],
  );
  if (box === null) return <NotFound />;
  return (
    <LazyPane
      load={loadPreview}
      props={{
        box,
        name,
        armed,
        onOpenAgent: (agentId: string) => useWorkspaceStore.getState().open({ kind: "agent", id: agentId }),
      }}
    />
  );
}

/** A failed chunk shows a Retry state in the pane (LazyPane); it is never retried by itself. */
function LazySettings({ section }: { readonly section: SettingsSection }) {
  return <LazyPane load={loadSettings} props={{ section }} />;
}

// Dev only (ADR 0011): `import.meta.env.DEV` is a build-time constant, so a production build drops the branch and with it
// the dynamic import: no gallery chunk exists. A dev chunk needs no LazyBoundary.
const DevGallery = import.meta.env.DEV
  ? lazy(() => import("../../gallery/Gallery.tsx").then((module) => ({ default: module.Gallery })))
  : null;

/** One renderer per item kind. */
export const PANE_RENDERERS: Renderers = {
  home: () => <HomePane />,
  session: (item) => <SessionPane key={item.id} sessionId={item.id} />,
  settings: (item) => <LazySettings section={item.section} />,
  files: (item) => <LazyPane key={item.root} load={loadFiles} props={{ root: item.root }} />,
  changes: (item) => (
    <LazyPane
      key={item.root}
      load={loadChanges}
      props={{ root: item.root, onOpenFile: openInFiles(item.root) }}
    />
  ),
  terminal: (item) => (
    <LazyPane
      key={item.id}
      load={loadTerminal}
      props={{
        id: item.id,
        onClose: () => leaveTerminal(item),
        onOpen: (id: string) => openTerminalInstead(item, id),
      }}
    />
  ),
  lane: (item) => (
    <LazyPane
      key={item.id}
      load={loadLane}
      props={{ laneId: item.id, onOpenArchived: openArchivedLanes, ...lanePanes }}
    />
  ),
  compare: (item) => (
    <LazyPane
      key={item.id}
      load={loadCompare}
      props={{ fanoutId: item.id, onOpenLane: openLane, onRunAgain: runAgain }}
    />
  ),
  tasks: () => <TasksPane />,
  trigger: (item) => <TriggerPane key={item.id} triggerId={item.id} />,
  agent: (item) => <AgentTab key={item.id} agentId={item.id} />,
  preview: (item) => <PreviewTab key={`${item.box}/${item.name}`} box={item.box} name={item.name} />,
  "dev-ui": () =>
    DevGallery ? (
      <Suspense fallback={null}>
        <DevGallery />
      </Suspense>
    ) : (
      <NotFound />
    ),
};

export function renderItem(item: ItemRef): ReactNode {
  const render = PANE_RENDERERS[item.kind] as (item: ItemRef) => ReactNode;
  return render(item);
}
