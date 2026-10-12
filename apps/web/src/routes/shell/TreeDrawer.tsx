import { Dialog } from "@pap/ui/overlays";
import { useEffect } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { SessionTree } from "./SessionTree.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The ⌘B drawer. Loaded on first use and mounted only while open (it imports the overlay chunk). */
export default function TreeDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  useEffect(() => {
    if (open)
      void useSessionsCache
        .getState()
        .refresh(getRuntime().rpc)
        .catch(() => reportClientIssue("sessions_list_failed"));
  }, [open]);
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
