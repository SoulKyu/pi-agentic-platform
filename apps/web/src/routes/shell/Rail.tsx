import { IconAccount, IconButton, IconSettings, Mark, toast } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { logout } from "../../features/auth/auth-api.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useT } from "../../i18n/index.ts";
import { navigateTo } from "./navigate.ts";
import { useShortcut } from "./shortcut.ts";

// The menu stack (Radix dropdown, dialog sheet) is a separate chunk, fetched on the first press of the account button.
const LazyMenu = lazy(() => import("@pap/ui/overlays").then((module) => ({ default: module.Menu })));

interface RailProps {
  readonly username: string | null;
  onSignedOut(): void;
}

/** Logo, Settings and the account menu. Agent avatars arrive with M11. */
export function Rail({ username, onSignedOut }: RailProps) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useShortcut("settings.open");
  const [menuAsked, setMenuAsked] = useState(false);
  const signOut = () =>
    void logout().then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }));
  const account = (
    <IconButton icon={IconAccount} label={t("shell.rail.account")} onClick={() => setMenuAsked(true)} />
  );
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
      {menuAsked ? (
        <Suspense fallback={account}>
          <LazyMenu
            defaultOpen
            label={t("shell.rail.account")}
            closeLabel={t("ui.close")}
            trigger={account}
            items={[
              ...(username ? [{ id: "user", label: username, disabled: true, onSelect: () => {} }] : []),
              { id: "sign-out", label: t("shell.rail.signOut"), onSelect: signOut },
            ]}
          />
        </Suspense>
      ) : (
        account
      )}
    </nav>
  );
}
