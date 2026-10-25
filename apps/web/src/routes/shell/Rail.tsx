import { IconAccount, IconButton, IconSettings, IconTasks, Mark } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { runCommand } from "../../features/commands/index.ts";
import { pathOfItem } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { AgentRail } from "./AgentRail.tsx";
import { signOut } from "./sign-out.ts";
import { RoleChip } from "./RoleChip.tsx";
import { go } from "./tab-actions.ts";
import { useShortcut } from "./shortcut.ts";

interface RailProps {
  readonly username: string | null;
  onSignedOut(): void;
}

/** Logo, the agents (M11R108), Tasks, Settings and the account menu (with the keyboard shortcuts, §5). */
export function Rail({ username, onSignedOut }: RailProps) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useShortcut("settings.open");
  const lazyText = useLazyFailureText();
  return (
    <nav
      aria-label={t("shell.rail.label")}
      data-slot="rail"
      className="flex w-rail shrink-0 flex-col items-center gap-s2 border-r border-border bg-bg-side py-s2 rail-right:border-l rail-right:border-r-0"
    >
      <Link to="/" aria-label={t("app.name")} className="focus-ring rounded-sm">
        <Mark />
      </Link>
      <AgentRail />
      <div className="flex-1" />
      <IconButton
        icon={IconTasks}
        label={t("shell.rail.tasks")}
        onClick={() => go(navigate, pathOfItem({ kind: "tasks" }))}
      />
      <IconButton
        icon={IconSettings}
        label={t("shell.rail.settings")}
        shortcut={settings.keys}
        shortcutJoiner={settings.joiner}
        onClick={() => go(navigate, pathOfItem({ kind: "settings", section: "appearance" }))}
      />
      <LazyMenu
        label={t("shell.rail.account")}
        closeLabel={t("ui.close")}
        text={lazyText}
        trigger={(ask) => <IconButton icon={IconAccount} label={t("shell.rail.account")} onClick={ask} />}
        items={[
          ...(username
            ? [
                {
                  id: "user",
                  label: username,
                  disabled: true,
                  onSelect: () => {},
                },
              ]
            : []),
          {
            id: "shortcuts",
            label: t("shell.rail.shortcuts"),
            onSelect: () => void runCommand("shortcuts.help"),
          },
          { id: "sign-out", label: t("shell.rail.signOut"), onSelect: () => signOut(onSignedOut) },
        ]}
      />
      {username ? <RoleChip /> : null}
    </nav>
  );
}
