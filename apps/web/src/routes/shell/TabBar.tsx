import { IconButton, IconPlus, IconSplit, OpenTab } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { activeTab, pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { itemTitle } from "./item-title.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { LANE_TAB_STATUS } from "../../lib/lane-status-view.ts";
import { laneStatusOf } from "../../lib/lane-sessions.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useTriggerNames } from "./use-tasks-feed.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { closeItem, go, otherItem, takeFocusAfterClose, toggleSplit } from "./tab-actions.ts";

const ROVING_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

const NEW_TAB_ID = "new-tab-button";

/** The open items as a tablist with roving focus, then New tab and the split toggle. */
export function TabBar() {
  const t = useT();
  const navigate = useNavigate();
  const ws = useWorkspaceStore((state) => state.ws);
  const sessions = useShellStore((state) => state.view.sessions);
  const views = useViewLabels((state) => state.labels);
  const lanes = useLaneStore((state) => state.view);
  const triggers = useTriggerNames();
  const listRef = useRef<HTMLDivElement>(null);
  const active = activeTab(ws);
  const other = otherItem(ws);

  useEffect(() => {
    if (!takeFocusAfterClose()) return;
    const next = ws.active === null ? null : document.getElementById(`tab-${ws.active}`);
    (next ?? document.getElementById(NEW_TAB_ID))?.focus();
  }, [ws]);

  useEffect(() => {
    if (ws.active === null) return;
    document.getElementById(`tab-${ws.active}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ws.active]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ROVING_KEYS.includes(event.key)) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const from = buttons.indexOf(event.target as HTMLElement);
    if (from === -1) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (from + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[target]?.focus();
  };

  return (
    <div className="flex h-bar shrink-0 items-center gap-s1 border-b border-border bg-bg px-s2">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("shell.tabs.label")}
        onKeyDown={moveFocus}
        className="flex min-w-0 items-center gap-s1 overflow-x-auto"
      >
        {ws.tabs.map((tab) => {
          const title = itemTitle(tab.item, sessions, views, t, lanes, triggers);
          const item = tab.item;
          const running = item.kind === "session" && sessions.get(item.id)?.status === "running";
          const lane = item.kind === "lane" ? lanes.lanes.get(item.id) : undefined;
          const laneStatus = lane ? laneStatusOf(lane, sessions.values()) : null;
          const dot = laneStatus ? LANE_TAB_STATUS[laneStatus] : null;
          return (
            <OpenTab
              key={tab.key}
              tabId={`tab-${tab.key}`}
              panelId="pane-main"
              title={title}
              active={tab.key === ws.active}
              status={running ? "running" : dot}
              {...(laneStatus && dot ? { statusLabel: t(`shell.lane.status.${laneStatus}`) } : {})}
              closeLabel={t("shell.tabs.close", { title })}
              onSelect={() => go(navigate, pathOfItem(tab.item))}
              onClose={() => closeItem(navigate, tab.key)}
            />
          );
        })}
      </div>
      <IconButton
        id={NEW_TAB_ID}
        icon={IconPlus}
        label={t("shell.tabs.new")}
        onClick={() => go(navigate, "/")}
      />
      <IconButton
        icon={IconSplit}
        label={active?.split ? t("shell.tabs.unsplit") : t("shell.tabs.split")}
        disabled={!active || (!active.split && !other)}
        onClick={() => void toggleSplit()}
      />
    </div>
  );
}
