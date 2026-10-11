import { cn, FOCUS_RING, IconButton, IconClose } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { itemTitle } from "./item-title.ts";
import { useSessionsCache } from "./sessions-cache.ts";
import { closeItem, go } from "./tab-actions.ts";

interface TabSwitcherProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

/** The phone's open items in a bottom sheet. Loaded on first use and mounted only while open (it imports the overlay chunk). */
export default function TabSwitcher({ open, onOpenChange }: TabSwitcherProps) {
  const t = useT();
  const navigate = useNavigate();
  const ws = useWorkspaceStore((state) => state.ws);
  const sessions = useSessionsCache((state) => state.sessions);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell.mobile.tabs")}
      closeLabel={t("ui.close")}
      variant="sheet"
    >
      {ws.tabs.length === 0 ? <p className="p-s3 text-ui text-muted">{t("shell.mobile.noTabs")}</p> : null}
      <ul className="flex flex-col gap-s1 p-s3">
        {ws.tabs.map((tab) => {
          const title = itemTitle(tab.item, sessions, t);
          return (
            <li key={tab.key} className="flex items-center gap-s1">
              <button
                type="button"
                aria-current={tab.key === ws.active ? "page" : undefined}
                onClick={() => {
                  go(navigate, pathOfItem(tab.item));
                  onOpenChange(false);
                }}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-sm px-s2 py-s2 text-left text-ui pointer-coarse:min-h-11",
                  tab.key === ws.active ? "bg-surface-2 text-fg" : "text-muted",
                  FOCUS_RING,
                )}
              >
                {title}
              </button>
              <IconButton
                icon={IconClose}
                label={t("shell.tabs.close", { title })}
                onClick={() => closeItem(navigate, tab.key)}
              />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
