import { lazy, Suspense, type ReactNode } from "react";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { useWorkspaceStore, type ItemRef, type SettingsSection } from "../../features/workspace/index.ts";
import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";
import { LazyPane } from "./LazyPane.tsx";
import { leaveTerminal, openTerminalInstead } from "./terminal-tab.ts";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

// The Settings screen and all its sections are one chunk, fetched when a settings pane first shows.
const loadSettings = () =>
  import("../settings/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen }));

// The session screen is its own chunk too, so what later milestones add to it stays out of the initial bundle. The
// session list (the home screen) stays eager: the first paint at "/" does not wait for a fetch.
const loadSession = () =>
  import("../../features/sessions/SessionScreen.tsx").then((module) => ({ default: module.SessionScreen }));

// The M8 panes: one chunk and one catalog each, fetched when a pane of that kind first shows (M8R71).
// The files pane comes with the shell's step-up entry (M8R117).
const loadFiles = () => import("./files-pane-entry.tsx").then((m) => ({ default: m.FilesPaneEntry }));
const loadChanges = () =>
  import("../../features/vcs/ChangesPane.tsx").then((m) => ({ default: m.ChangesPane }));
const loadTerminal = () =>
  import("../../features/terminal/TerminalPane.tsx").then((m) => ({ default: m.TerminalPane }));

/**
 * "Open in Files" from the changes pane: the shell opens the folder's Files pane (features never import each other).
 * The Files pane keeps its tabs to itself, so the file is not preselected there.
 */
const openInFiles = (root: string) => () => useWorkspaceStore.getState().open({ kind: "files", root });

/** The session screen gets the account's tool card detail from here: features do not read each other's stores. */
function SessionPane({ sessionId }: { readonly sessionId: string }) {
  const toolDetail = useAppearanceStore((state) => state.account.toolDetail);
  return <LazyPane load={loadSession} props={{ sessionId, toolDetail }} />;
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
  home: () => <SessionListScreen />,
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
