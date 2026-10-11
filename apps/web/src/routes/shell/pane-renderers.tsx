import type { ReactNode } from "react";
import type { ItemRef, SettingsSection } from "../../features/workspace/index.ts";
import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";
import { SessionScreen } from "../../features/sessions/SessionScreen.tsx";
import { LazyPane } from "./LazyPane.tsx";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

// The Settings screen and all its sections are one chunk, fetched when a settings pane first shows.
const loadSettings = () =>
  import("../settings/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen }));

/** A failed chunk shows a Retry state in the pane (LazyPane); it is never retried by itself. */
function LazySettings({ section }: { readonly section: SettingsSection }) {
  return <LazyPane load={loadSettings} props={{ section }} />;
}

/** One renderer per item kind; Task 28 replaces the dev-ui placeholder. */
export const PANE_RENDERERS: Renderers = {
  home: () => <SessionListScreen />,
  session: (item) => <SessionScreen key={item.id} sessionId={item.id} />,
  settings: (item) => <LazySettings section={item.section} />,
  "dev-ui": () => <NotFound />,
};

export function renderItem(item: ItemRef): ReactNode {
  const render = PANE_RENDERERS[item.kind] as (item: ItemRef) => ReactNode;
  return render(item);
}
