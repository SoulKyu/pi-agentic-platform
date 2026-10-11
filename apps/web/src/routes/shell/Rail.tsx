import { IconAccount, IconButton, IconSettings, Mark } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { reportClientIssue } from "../../lib/report.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { navigateTo } from "./navigate.ts";
import { signOut } from "./sign-out.ts";
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
      <LazyMenu
        label={t("shell.rail.account")}
        closeLabel={t("ui.close")}
        text={lazyText}
        trigger={(ask) => <IconButton icon={IconAccount} label={t("shell.rail.account")} onClick={ask} />}
        items={[
          ...(username ? [{ id: "user", label: username, disabled: true, onSelect: () => {} }] : []),
          { id: "sign-out", label: t("shell.rail.signOut"), onSelect: () => signOut(onSignedOut) },
        ]}
      />
    </nav>
  );
}
