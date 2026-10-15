import "./register-lanes-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button, Icon, IconChevronDown } from "@pap/ui";
import { Menu } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import { laneSessions } from "../../lib/lane-sessions.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { useShellStore } from "../../stores/shell-store.ts";

/** Picks which session of the lane the chat pane shows (M9R62). Nothing to pick: nothing is drawn. */
export function LaneSessionMenu({
  lane,
  current,
  onPick,
}: {
  readonly lane: Pick<LaneView, "worktree">;
  readonly current: string | null;
  onPick(sessionId: string): void;
}) {
  const t = useT();
  const sessions = useShellStore((state) => state.view.sessions);
  const own = laneSessions(lane, sessions.values()).sort((a, b) => a.createdAt - b.createdAt);
  if (own.length === 0) return null;
  const label = (session: (typeof own)[number]) => sessionLabel(session) || t("lanes.session.untitled");
  const shown = own.find((session) => session.id === current);
  return (
    <Menu
      label={t("lanes.session.menu")}
      closeLabel={t("lanes.action.close")}
      trigger={
        <Button variant="ghost" size="sm" aria-label={t("lanes.session.menu")}>
          <span className="max-w-48 truncate">{shown ? label(shown) : t("lanes.session.menu")}</span>
          <Icon icon={IconChevronDown} size={14} />
        </Button>
      }
      items={own.map((session) => ({
        id: session.id,
        label: label(session),
        onSelect: () => onPick(session.id),
      }))}
    />
  );
}
