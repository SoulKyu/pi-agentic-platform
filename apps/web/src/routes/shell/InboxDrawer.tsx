import { EmptyState } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The right drawer. Its stream arrives with M10/M11; until then it says what it is for. */
export default function InboxDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell.inbox.title")}
      closeLabel={t("ui.close")}
      variant="drawer-right"
    >
      <div className="p-s3">
        <EmptyState title={t("shell.inbox.emptyTitle")} purpose={t("shell.inbox.emptyPurpose")} />
      </div>
    </Dialog>
  );
}
