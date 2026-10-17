import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { syncAccountAppearance } from "../../features/appearance/index.ts";
import {
  detectPlatform,
  installDispatcher,
  syncKeybindings,
  useKeybindingsStore,
} from "../../features/commands/index.ts";
import { isOpenPath, landingSegmentOf } from "../../features/notifications/landing-path.ts";
import { itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, useConnectionState, windowTimers } from "../../runtime/index.ts";
import { startPresence } from "../../runtime/presence.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { usePwa } from "../../stores/pwa.ts";

const granted = () => typeof Notification !== "undefined" && Notification.permission === "granted";

export function useShellEffects(shell: { readonly mobile: boolean; treeOpen(): boolean }): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = useWorkspaceStore((state) => state.open);
  const navigate = useNavigate();
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);

  // The URL names the active item; the tab follows it. An unknown path opens nothing. An empty workspace opens the
  // URL's item again: closing the last tab at "/" leaves the path unchanged, so the pathname alone would not.
  const empty = useWorkspaceStore((state) => state.ws.active === null);
  useEffect(() => {
    const item = itemFromPath(pathname, import.meta.env.DEV);
    if (item) open(item);
  }, [pathname, empty, open]);

  // Account settings, each time the socket opens. They map their own failures to a status the screens show;
  // the catches only report a rejection a future change might introduce.
  useEffect(() => {
    if (connection !== "open") return;
    void syncAccountAppearance(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void syncKeybindings(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
  }, [connection, runtime]);

  // Whether the owner is looking, for the daemon's push decision (M12R11). It runs without any permission.
  useEffect(
    () =>
      startPresence({
        rpc: runtime.rpc,
        connection: runtime.connection,
        timers: windowTimers,
        doc: document,
        win: window,
      }),
    [runtime],
  );

  // Push (M12R12). The push code is a lazy chunk, loaded only for a device that already granted the permission.
  // The handler is registered on each mount: sign-out clears it, so one registration at boot would be gone for the next login.
  const bound = useRef(false);
  useEffect(() => {
    if (connection !== "open" || bound.current || !granted()) return;
    bound.current = true;
    void import("../../features/notifications/start.ts")
      .then((start) => start.rebindDevice(runtime.rpc, windowTimers))
      .catch(() => reportClientIssue("push_bind_failed"));
  }, [connection, runtime]);
  useEffect(
    () =>
      usePwa.getState().onResubscribe(() => {
        if (!granted()) return;
        void import("../../features/notifications/start.ts")
          .then((start) => start.resubscribeDevice(runtime.rpc, windowTimers))
          .catch(() => reportClientIssue("push_bind_failed"));
      }),
    [runtime],
  );

  // One key dispatcher while the shell is mounted; it reads the drawer state at each key.
  // The worker's `open` message: a tap on a notification while a window is open. Only `/n/<push id>` is followed.
  useEffect(
    () =>
      usePwa.getState().onOpen((path) => {
        if (isOpenPath(path)) navigate({ to: path }).catch(() => reportClientIssue("command_failed"));
      }),
    [navigate],
  );

  // The landing asked for the Inbox and has left the page: show it (the phone's section, or the desktop drawer).
  useEffect(() => {
    if (landingSegmentOf(pathname) !== null || !useInboxReveal.getState().takeOpen()) return;
    if (!runCommand("mobile.inbox.open")) runCommand("drawer.inbox.open");
  }, [pathname]);

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
