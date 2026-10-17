import { Dialog } from "@pap/ui/overlays";
import InboxPanel from "../../features/inbox/InboxPanel.tsx";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useFocusEntry } from "../../stores/focus-entry.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The right drawer (decision 29): the panel under a visually hidden dialog title, since the panel heads itself. A click on a row opens its session and closes the drawer. */
export default function InboxDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
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
          useWorkspaceStore.getState().open({ kind: "agent", id: agentId });
          onOpenChange(false);
        }}
        onOpenSession={(id) => {
          useWorkspaceStore.getState().open({ kind: "session", id });
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
