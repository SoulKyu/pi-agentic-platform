import type { Translate } from "../../i18n/index.ts";
import type { ItemRef } from "../../features/workspace/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { sessionLabel } from "./session-label.ts";

/** A session the store holds is titled from it, else from its own view (older than the snapshot's window, M4R86). */
export function itemTitle(
  item: ItemRef,
  sessions: ReadonlyMap<string, Pick<SessionView, "name" | "cwd">>,
  views: Readonly<Record<string, Pick<SessionView, "name" | "cwd">>>,
  t: Translate,
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
    case "dev-ui":
      // Production has no gallery: the tab of a /dev/ui item must not confirm that it exists elsewhere.
      return import.meta.env.DEV ? t("shell.tab.devUi") : t("shell.notFound.title");
  }
}
