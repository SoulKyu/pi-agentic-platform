import { IconButton, IconPlus, IconSplit, OpenTab } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { registerCommand } from "../../features/commands/index.ts";
import {
  activeTab,
  pathOfItem,
  useWorkspaceStore,
  type ItemRef,
  type Workspace,
} from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { itemTitle } from "./item-title.ts";
import { useSessionsCache } from "./sessions-cache.ts";

const ROVING_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

type Navigate = ReturnType<typeof useNavigate>;

const go = (navigate: Navigate, path: string) =>
  void navigate({ to: path }).catch(() => reportClientIssue("command_failed"));

function goToActive(navigate: Navigate): void {
  const next = activeTab(useWorkspaceStore.getState().ws);
  go(navigate, next ? pathOfItem(next.item) : "/");
}

function closeItem(navigate: Navigate, key: string): void {
  const store = useWorkspaceStore.getState();
  const wasActive = store.ws.active === key;
  store.close(key);
  if (wasActive) goToActive(navigate);
}

/** The tab before the active one (the most recent other item), else the one after; null when alone. */
function otherItem(ws: Workspace): ItemRef | null {
  const index = ws.tabs.findIndex((tab) => tab.key === ws.active);
  return (ws.tabs[index - 1] ?? ws.tabs[index + 1])?.item ?? null;
}

/** False when there is nothing to do (no active tab, or nothing to split with). */
function toggleSplit(): boolean {
  const store = useWorkspaceStore.getState();
  const tab = activeTab(store.ws);
  if (!tab) return false;
  if (tab.split) store.unsplit(tab.key);
  else {
    const item = otherItem(store.ws);
    if (!item) return false;
    store.split(tab.key, item);
  }
  return true;
}

/** The open items as a tablist with roving focus, then New tab and the split toggle. */
export function TabBar() {
  const t = useT();
  const navigate = useNavigate();
  const ws = useWorkspaceStore((state) => state.ws);
  const sessions = useSessionsCache((state) => state.sessions);
  const listRef = useRef<HTMLDivElement>(null);
  const active = activeTab(ws);
  const other = otherItem(ws);

  // The shortcuts act on the store at the key press; they live while the bar is mounted.
  useEffect(() => {
    const step = (by: 1 | -1) => () => {
      useWorkspaceStore.getState().cycle(by);
      goToActive(navigate);
    };
    const offs = [
      registerCommand("tab.next", step(1)),
      registerCommand("tab.prev", step(-1)),
      registerCommand("tab.close", () => {
        const key = useWorkspaceStore.getState().ws.active;
        if (key === null) return false;
        closeItem(navigate, key);
      }),
      registerCommand("pane.split", () => toggleSplit()),
    ];
    return () => offs.forEach((off) => off());
  }, [navigate]);

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
    <div className="flex h-bar shrink-0 items-center gap-s1 border-b border-border bg-bg-side px-s2">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("shell.tabs.label")}
        onKeyDown={moveFocus}
        className="flex min-w-0 items-center gap-s1 overflow-x-auto"
      >
        {ws.tabs.map((tab) => {
          const title = itemTitle(tab.item, sessions, t);
          const item = tab.item;
          const running =
            item.kind === "session" &&
            sessions.find((session) => session.id === item.id)?.status === "running";
          return (
            <OpenTab
              key={tab.key}
              tabId={`tab-${tab.key}`}
              panelId="pane-main"
              title={title}
              active={tab.key === ws.active}
              status={running ? "running" : null}
              closeLabel={t("shell.tabs.close", { title })}
              onSelect={() => go(navigate, pathOfItem(tab.item))}
              onClose={() => closeItem(navigate, tab.key)}
            />
          );
        })}
      </div>
      <IconButton icon={IconPlus} label={t("shell.tabs.new")} onClick={() => go(navigate, "/")} />
      <IconButton
        icon={IconSplit}
        label={active?.split ? t("shell.tabs.unsplit") : t("shell.tabs.split")}
        disabled={!active || (!active.split && !other)}
        onClick={() => void toggleSplit()}
      />
    </div>
  );
}
