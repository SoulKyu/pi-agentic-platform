import type { ReactNode } from "react";
import type { ItemRef } from "../../features/workspace/index.ts";
import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";
import { SessionScreen } from "../../features/sessions/SessionScreen.tsx";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { LazyPanel } from "./LazyPanel.tsx";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

// The Settings screen and all its sections are one chunk, fetched when a settings pane first shows.
const loadSettings = () =>
  import("../settings/SettingsScreen.tsx").then((module) => ({ default: module.SettingsScreen }));
const noop = () => {};

/** A failed chunk leaves the pane empty: LazyPanel has already said to reload. */
function LazySettings({ section }: { readonly section: SettingsSection }) {
  return <LazyPanel load={loadSettings} open props={{ section }} onFailed={noop} />;
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
