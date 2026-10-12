import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import ProjectTree from "../../features/projects/ProjectTree.tsx";
import { usePaletteChord } from "./shortcut.ts";

interface DrawerProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The ⌘B drawer; the tree and its strings come with this chunk. Loaded on first use and mounted only while open (it imports the overlay chunk). */
export default function TreeDrawer({ open, onOpenChange }: DrawerProps) {
  const t = useT();
  const chord = usePaletteChord();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell.top.tree")}
      closeLabel={t("ui.close")}
      variant="drawer-left"
    >
      <ProjectTree onPick={() => onOpenChange(false)} chord={chord} />
    </Dialog>
  );
}
