import type { ProjectSummary } from "@pap/contracts";
import { create } from "zustand";
import { useShellStore } from "./shell-store.ts";

const KEY = "pap.project.v1";
const MAX_ID = 128;

function read(storage: Pick<Storage, "getItem"> | null): string | null {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? "null") as { v?: unknown; projectId?: unknown } | null;
    return value?.v === 1 &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0 &&
      value.projectId.length <= MAX_ID
      ? value.projectId
      : null;
  } catch {
    // A value another version or a person wrote: the default, as every device setting does (M4R105).
    return null;
  }
}

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

interface CurrentProjectState {
  readonly projectId: string | null;
  /** The last choice could not be stored: it holds for this page only. */
  readonly storageRefused: boolean;
  choose(projectId: string | null): void;
}

/** The project the switcher shows, per device (M4R102). */
export const useCurrentProject = create<CurrentProjectState>()((set) => ({
  projectId: read(storage()),
  storageRefused: false,
  choose(projectId) {
    let refused = false;
    try {
      storage()?.setItem(KEY, JSON.stringify({ v: 1, projectId }));
    } catch {
      refused = true;
    }
    set({ projectId, storageRefused: refused });
  },
}));

/** The project the switcher, the tree and home narrow to: the stored one when the store knows it, else none (M4R102). */
export const effectiveProjectId = (
  stored: string | null,
  projects: ReadonlyMap<string, ProjectSummary>,
): string | null => (stored !== null && projects.has(stored) ? stored : null);

export function useEffectiveProject(): ProjectSummary | null {
  const stored = useCurrentProject((state) => state.projectId);
  const projects = useShellStore((state) => state.view.projects);
  const id = effectiveProjectId(stored, projects);
  return id === null ? null : (projects.get(id) ?? null);
}
