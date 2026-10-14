import { OpenTab } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { tabTitles } from "./files.vm.ts";

interface ViewerTabsProps {
  readonly tabs: readonly string[];
  readonly active: string | null;
  /** Names the tab and panel ids (`tabIdOf(idPrefix, path)`); the viewer panel is `panelId`. */
  readonly idPrefix: string;
  readonly panelId: string;
  /** The paths with unsaved edits. */
  readonly dirty: ReadonlySet<string>;
  onSelect(path: string): void;
  onClose(path: string): void;
}

export const tabIdOf = (prefix: string, path: string): string => `${prefix}-${encodeURIComponent(path)}`;

/** The open files (DESIGN §8 open tabs). Closing a tab closes the view, never the file. */
export function ViewerTabs({ tabs, active, idPrefix, panelId, dirty, onSelect, onClose }: ViewerTabsProps) {
  const t = useT();
  if (tabs.length === 0) return null;
  const titles = tabTitles(tabs);
  return (
    <div
      role="tablist"
      aria-label={t("files.tabs.label")}
      className="flex shrink-0 gap-s1 overflow-x-auto border-b border-border px-s2 py-s1"
    >
      {tabs.map((path, index) => (
        <OpenTab
          key={path}
          tabId={tabIdOf(idPrefix, path)}
          panelId={path === active ? panelId : undefined}
          title={titles[index] ?? path}
          active={path === active}
          status={dirty.has(path) ? "waiting" : null}
          closeLabel={t(dirty.has(path) ? "files.tabs.closeDirty" : "files.tabs.close", {
            name: titles[index] ?? path,
          })}
          onSelect={() => onSelect(path)}
          onClose={() => onClose(path)}
        />
      ))}
    </div>
  );
}
