import type { ReactNode } from "react";
import type { ItemRef } from "../../features/workspace/index.ts";
import { SessionListScreen } from "../../features/sessions/SessionListScreen.tsx";
import { SessionScreen } from "../../features/sessions/SessionScreen.tsx";
import { NotFound } from "./NotFound.tsx";

type Renderers = { readonly [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode };

/** One renderer per item kind; Tasks 24 and 28 replace the two placeholders. */
export const PANE_RENDERERS: Renderers = {
  home: () => <SessionListScreen />,
  session: (item) => <SessionScreen key={item.id} sessionId={item.id} />,
  settings: () => <NotFound />,
  "dev-ui": () => <NotFound />,
};

export function renderItem(item: ItemRef): ReactNode {
  const render = PANE_RENDERERS[item.kind] as (item: ItemRef) => ReactNode;
  return render(item);
}
