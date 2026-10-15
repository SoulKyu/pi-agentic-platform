import type { Translate } from "../../i18n/index.ts";
import type { ItemRef } from "../../features/workspace/index.ts";
import type { ViewLabel } from "../../stores/view-labels-store.ts";
import { EMPTY_LANES, type LaneState } from "../../stores/lane-reducer.ts";
import { sessionLabel } from "../../lib/session-label.ts";

/** A session the store holds is titled from it, else from its own view (older than the snapshot's window, M4R86). */
export function itemTitle(
  item: ItemRef,
  sessions: ReadonlyMap<string, ViewLabel>,
  views: Readonly<Record<string, ViewLabel>>,
  t: Translate,
  lanes: Pick<LaneState, "lanes" | "fanouts"> = EMPTY_LANES,
): string {
  switch (item.kind) {
    case "session":
      return (
        sessionLabel(sessions.get(item.id) ?? views[item.id] ?? { name: null, cwd: "" }) ||
        t("shell.tab.session")
      );
    case "home":
      return t("shell.tab.home");
    case "settings":
      return t("shell.tab.settings");
    case "files":
      return t("shell.surface.files");
    case "changes":
      return t("shell.surface.changes");
    case "terminal":
      return t("shell.surface.terminal");
    case "lane":
      // A lane the store no longer holds was archived (or never existed): the pane says so; the tab keeps a word.
      return lanes.lanes.get(item.id)?.branch || t("shell.tab.lane");
    case "compare":
      return t("shell.tab.compare", { count: lanes.fanouts.get(item.id)?.laneIds.length ?? 0 });
    case "dev-ui":
      // Production has no gallery: the tab of a /dev/ui item must not confirm that it exists elsewhere.
      return import.meta.env.DEV ? t("shell.tab.devUi") : t("shell.notFound.title");
  }
}
