import { create } from "zustand";

interface ProjectSettingsRequestState {
  /** The box project whose settings are open, or null. */
  readonly projectId: string | null;
  ask(projectId: string): void;
  close(): void;
}

/** The project page and the project menu open the box settings through this; the shell's host owns the dialog. */
export const useProjectSettingsRequest = create<ProjectSettingsRequestState>()((set) => ({
  projectId: null,
  ask: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));
