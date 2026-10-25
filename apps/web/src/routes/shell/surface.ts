import type { Role } from "@pap/contracts";
import { useEffect } from "react";
import { isValidRoot, itemKey, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import type { ShellView } from "../../stores/shell-reducer.ts";
import { useSurfaceView, type SurfaceView } from "./surface-view.ts";

export type Surface = "changes" | "terminal" | "files";

/** The id of the split pane of a tab: "Show again" focuses it. */
export const SPLIT_PANE_ID = "pane-split";

/** Where a session lives: the root of its project (null without one) and its own folder (null when not absolute). */
export interface SessionPlace {
  readonly root: string | null;
  readonly cwd: string | null;
  /** The project is a box project: its terminal is a box terminal, the only kind a member has. */
  readonly box: boolean;
}

/** Null for a session the shell store does not hold: the surfaces stay off for it. */
export function placeOf(view: ShellView, sessionId: string): SessionPlace | null {
  const session = view.sessions.get(sessionId);
  if (!session) return null;
  const root = session.projectId === null ? null : (view.projects.get(session.projectId)?.root ?? null);
  return {
    root: root !== null && isValidRoot(root) ? root : null,
    cwd: isValidRoot(session.cwd) ? session.cwd : null,
    box: session.projectId !== null && view.projects.get(session.projectId)?.kind === "box",
  };
}

/** A member opens a terminal only in a box (the owner also on the host). */
export const terminalAllowed = (place: SessionPlace | null, role: Role): boolean =>
  place?.cwd != null && (role === "owner" || place.box);

const loadTerminal = () => import("./surface-terminal.ts");

/** Keeps the `terminal` stream open while a session surface is on screen: the terminal store feeds from it. */
export function useTerminalFeed(): void {
  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    loadTerminal()
      .then((module) => {
        if (live) stop = module.startTerminalFeed();
      })
      .catch(() => reportClientIssue("lazy_chunk_failed"));
    return () => {
      live = false;
      stop?.();
    };
  }, []);
}

export async function itemFor(sessionId: string, which: Surface): Promise<ItemRef | null> {
  const place = placeOf(useShellStore.getState().view, sessionId);
  if (!place) return null;
  if (which === "terminal") {
    const id = place.cwd === null ? null : await (await loadTerminal()).terminalFor(sessionId, place.cwd);
    return id === null ? null : { kind: "terminal", id };
  }
  return place.root === null ? null : { kind: which, root: place.root };
}

const VIEWS: Readonly<Record<Surface, SurfaceView>> = { changes: "review", terminal: "term", files: "files" };

/** Splits the session tab with the surface, or focuses it when it already is the split. False: nothing to show. */
export async function showSurface(tabKey: string, sessionId: string, which: Surface): Promise<boolean> {
  const item = await itemFor(sessionId, which);
  const tab = useWorkspaceStore.getState().ws.tabs.find((one) => one.key === tabKey);
  if (item === null || !tab) return false;
  if (tab.split && itemKey(tab.split.item) === itemKey(item)) {
    document.getElementById(SPLIT_PANE_ID)?.focus();
  } else {
    useWorkspaceStore.getState().split(tabKey, item);
  }
  useSurfaceView.getState().show(tabKey, VIEWS[which]);
  return true;
}
