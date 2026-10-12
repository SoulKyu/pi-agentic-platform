import { Button, Icon, IconButton, IconInbox, IconSearch, IconTree, Kbd } from "@pap/ui";
import { runCommand } from "../../features/commands/index.ts";
import { useT } from "../../i18n/index.ts";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { useShortcut } from "./shortcut.ts";

/** The active item's title between the drawer buttons; their handlers arrive with the drawers. */
export function TopBar({ title }: { readonly title: string }) {
  const t = useT();
  const tree = useShortcut("drawer.tree.toggle");
  const inbox = useShortcut("drawer.inbox.toggle");
  const palette = useShortcut("palette.toggle");
  return (
    <header className="flex h-bar shrink-0 items-center gap-s2 border-b border-border bg-bg-side px-s2">
      <ProjectSwitcher />
      <IconButton
        icon={IconTree}
        label={t("shell.top.tree")}
        shortcut={tree.keys}
        shortcutJoiner={tree.joiner}
        onClick={() => void runCommand("drawer.tree.toggle")}
      />
      <span className="truncate text-ui font-semibold">{title}</span>
      <div className="flex-1" />
      <IconButton
        icon={IconInbox}
        label={t("shell.top.inbox")}
        shortcut={inbox.keys}
        shortcutJoiner={inbox.joiner}
        onClick={() => void runCommand("drawer.inbox.toggle")}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("shell.top.palette")}
        onClick={() => void runCommand("palette.toggle")}
      >
        {palette.keys.length > 0 ? (
          <Kbd keys={palette.keys} joiner={palette.joiner} />
        ) : (
          <Icon icon={IconSearch} size={14} />
        )}
      </Button>
    </header>
  );
}
