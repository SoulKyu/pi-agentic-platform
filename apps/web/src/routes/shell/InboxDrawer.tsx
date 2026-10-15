import { Dialog } from "@pap/ui/overlays";
import InboxPanel from "../../features/inbox/InboxPanel.tsx";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The right drawer (decision 29): the panel under a visually hidden dialog title, since the panel heads itself. A click on a row opens its session and closes the drawer. */
export default function InboxDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
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
        onOpenSession={(id) => {
          useWorkspaceStore.getState().open({ kind: "session", id });
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
