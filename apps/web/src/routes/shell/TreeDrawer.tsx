import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import { SessionTree } from "./SessionTree.tsx";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The ⌘B drawer. Loaded on first use and mounted only while open (it imports the overlay chunk). */
export default function TreeDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell.top.tree")}
      closeLabel={t("ui.close")}
      variant="drawer-left"
    >
      <SessionTree onPick={() => onOpenChange(false)} />
    </Dialog>
  );
}
