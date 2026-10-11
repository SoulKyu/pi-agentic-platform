import { IconAccount, IconButton, IconSettings, Mark, Menu, toast } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { logout } from "../../features/auth/auth-api.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useT } from "../../i18n/index.ts";
import { navigateTo } from "./navigate.ts";
import { useShortcut } from "./shortcut.ts";

interface RailProps {
  readonly username: string | null;
  onSignedOut(): void;
}

/** Logo, Settings and the account menu. Agent avatars arrive with M11. */
export function Rail({ username, onSignedOut }: RailProps) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useShortcut("settings.open");
  const signOut = () =>
    void logout().then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }));
  return (
    <nav
      aria-label={t("shell.rail.label")}
      data-slot="rail"
      className="flex w-rail shrink-0 flex-col items-center gap-s2 border-r border-border bg-bg-side py-s2 rail-right:border-l rail-right:border-r-0"
    >
      <Link to="/" aria-label={t("app.name")} className="focus-ring rounded-sm">
        <Mark />
      </Link>
      <div className="flex-1" />
      <IconButton
        icon={IconSettings}
        label={t("shell.rail.settings")}
        shortcut={settings.keys}
        shortcutJoiner={settings.joiner}
        onClick={() =>
          navigateTo(navigate, { kind: "settings", section: "appearance" }).catch(() =>
            reportClientIssue("command_failed"),
          )
        }
      />
      <Menu
        label={t("shell.rail.account")}
        closeLabel={t("ui.close")}
        trigger={<IconButton icon={IconAccount} label={t("shell.rail.account")} />}
        items={[
          { id: "user", label: username ?? "", disabled: true, onSelect: () => {} },
          { id: "sign-out", label: t("shell.rail.signOut"), onSelect: signOut },
        ]}
      />
    </nav>
  );
}
