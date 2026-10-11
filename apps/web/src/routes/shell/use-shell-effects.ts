import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { syncAccountAppearance } from "../../features/appearance/index.ts";
import {
  detectPlatform,
  installDispatcher,
  syncKeybindings,
  useKeybindingsStore,
} from "../../features/commands/index.ts";
import { itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { useSessionsCache } from "./sessions-cache.ts";

export function useShellEffects(shell: { readonly mobile: boolean; treeOpen(): boolean }): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = useWorkspaceStore((state) => state.open);
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);

  // The URL names the active item; the tab follows it. An unknown path opens nothing.
  useEffect(() => {
    const item = itemFromPath(pathname, import.meta.env.DEV);
    if (item) open(item);
  }, [pathname, open]);

  // Account settings and the session list, each time the socket opens. The three map their own failures to a
  // status the screens show; the catches only report a rejection a future change might introduce.
  useEffect(() => {
    if (connection !== "open") return;
    void syncAccountAppearance(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void syncKeybindings(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void useSessionsCache
      .getState()
      .refresh(runtime.rpc)
      .catch(() => reportClientIssue("sessions_list_failed"));
  }, [connection, runtime]);

  // One key dispatcher while the shell is mounted; it reads the drawer state at each key.
  const { mobile, treeOpen } = shell;
  useEffect(
    () =>
      installDispatcher({
        win: window,
        platform: detectPlatform(),
        rules: () => useKeybindingsStore.getState().rules,
        shell: () => ({ mobile, treeOpen: treeOpen() }),
      }),
    [mobile, treeOpen],
  );
}
