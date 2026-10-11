import { lazy, Suspense, type ReactNode } from "react";
import type { ItemRef, SettingsSection } from "../../features/workspace/index.ts";
import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";
import { LazyPane } from "./LazyPane.tsx";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

// The Settings screen and all its sections are one chunk, fetched when a settings pane first shows.
const loadSettings = () =>
  import("../settings/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen }));

// The session screen is its own chunk too, so what later milestones add to it stays out of the initial bundle. The
// session list (the home screen) stays eager: the first paint at "/" does not wait for a fetch.
const loadSession = () =>
  import("../../features/sessions/SessionScreen.tsx").then((module) => ({ default: module.SessionScreen }));

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
  session: (item) => <LazyPane key={item.id} load={loadSession} props={{ sessionId: item.id }} />,
  settings: (item) => <LazySettings section={item.section} />,
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
