import { IconButton, IconMore } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { useContext } from "react";
import { pathOfItem } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { ShellContext } from "./shell-context.ts";
import { signOut } from "./sign-out.ts";
import { go } from "./tab-actions.ts";

/** The Lists tab's header menu (§5): Settings and the account on a phone, without the palette (no rail there). */
export function MobileListsMenu({ onSettings }: { readonly onSettings: () => void }) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const shell = useContext(ShellContext);
  const items: MenuItem[] = [
    {
      id: "settings",
      label: t("shell.rail.settings"),
      onSelect: () => {
        onSettings(); // the path may not change (already on Settings): show the Work section anyway
        go(navigate, pathOfItem({ kind: "settings", section: "appearance" }));
      },
    },
    ...(shell?.username ? [{ id: "user", label: shell.username, disabled: true, onSelect: () => {} }] : []),
    ...(shell
      ? [{ id: "sign-out", label: t("shell.rail.signOut"), onSelect: () => signOut(shell.onSignedOut) }]
      : []),
  ];
  return (
    <div className="flex items-center justify-end border-b border-border px-s2 py-s1">
      <LazyMenu
        label={t("shell.mobile.more")}
        closeLabel={t("ui.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => <IconButton icon={IconMore} label={t("shell.mobile.more")} onClick={ask} />}
      />
    </div>
  );
}
