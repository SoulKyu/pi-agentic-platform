import { Dialog } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import InboxPanel from "../../features/inbox/InboxPanel.tsx";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { pathOfItem, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useFocusEntry } from "../../stores/focus-entry.ts";
import { go } from "./tab-actions.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * The right drawer (decision 29): the panel under a visually hidden dialog title, since the panel heads itself. A click
 * on a row opens its destination and closes the drawer. The URL names the active item, so the row navigates as well as
 * opening the tab: a reload (the stale-chunk guard, F5) then lands on the destination, not on the home the URL named.
 */
export default function InboxDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const navigate = useNavigate();
  const show = (item: ItemRef) => {
    useWorkspaceStore.getState().open(item);
    go(navigate, pathOfItem(item));
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell.inbox.title")}
      closeLabel={t("ui.close")}
      variant="drawer-right"
      hideTitle
    >
      <InboxPanel
        avatarStyle={avatarStyle}
        onOpenAgent={(agentId, entryId) => {
          const thread = useAgentsStore
            .getState()
            .view.agents.find((agent) => agent.id === agentId)?.threadSessionId;
          if (entryId !== null && thread != null)
            useFocusEntry.getState().ask({ sessionId: thread, entryId });
          show({ kind: "agent", id: agentId });
        }}
        onOpenSession={(id) => show({ kind: "session", id })}
        onOpenProject={(id) => {
          // The project's page is the home narrowed to it.
          useCurrentProject.getState().choose(id);
          go(navigate, "/");
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
