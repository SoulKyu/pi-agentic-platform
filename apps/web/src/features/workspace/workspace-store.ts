import type { Role } from "@pap/contracts";
import { create } from "zustand";
import { reportClientIssue } from "../../lib/report.ts";
import {
  closeTab,
  cycleTab,
  EMPTY_WORKSPACE,
  openItem,
  setSplitRatio,
  splitTab,
  unsplitTab,
  type ItemRef,
  type Workspace,
} from "./model.ts";
import { restrictWorkspace } from "./model.ts";
import { parseWorkspace, serializeWorkspace, WORKSPACE_KEY } from "./persist.ts";

interface WorkspaceState {
  readonly ws: Workspace;
  open(item: ItemRef): void;
  close(key: string): void;
  cycle(step: 1 | -1): void;
  split(key: string, item: ItemRef): void;
  unsplit(key: string): void;
  setRatio(key: string, ratio: number): void;
  /** A member restores no owner section: those tabs become Appearance. */
  restrict(role: Role): void;
}

function load(): Workspace {
  try {
    return parseWorkspace(localStorage.getItem(WORKSPACE_KEY), import.meta.env.DEV, () =>
      reportClientIssue("workspace_invalid"),
    );
  } catch {
    return EMPTY_WORKSPACE; // storage unreadable (locked-down browser): start empty
  }
}

function persist(ws: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, serializeWorkspace(ws));
  } catch {
    reportClientIssue("storage_refused"); // the in-memory workspace stays authoritative
  }
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const apply = (change: (ws: Workspace) => Workspace) => {
    const previous = get().ws;
    const ws = change(previous);
    if (ws === previous) return;
    set({ ws });
    persist(ws);
  };
  return {
    ws: load(),
    open: (item) => apply((ws) => openItem(ws, item)),
    close: (key) => apply((ws) => closeTab(ws, key)),
    cycle: (step) => apply((ws) => cycleTab(ws, step)),
    split: (key, item) => apply((ws) => splitTab(ws, key, item)),
    unsplit: (key) => apply((ws) => unsplitTab(ws, key)),
    setRatio: (key, ratio) => apply((ws) => setSplitRatio(ws, key, ratio)),
    restrict: (role) => apply((ws) => restrictWorkspace(ws, role)),
  };
});
