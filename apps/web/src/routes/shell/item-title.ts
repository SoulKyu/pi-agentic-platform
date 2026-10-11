import type { SessionSummary } from "@pap/contracts";
import type { Translate } from "../../i18n/index.ts";
import type { ItemRef } from "../../features/workspace/index.ts";

const basename = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? "";

export function itemTitle(item: ItemRef, sessions: readonly SessionSummary[], t: Translate): string {
  switch (item.kind) {
    case "session":
      return (
        basename(sessions.find((session) => session.id === item.id)?.cwd ?? "") || t("shell.tab.session")
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
