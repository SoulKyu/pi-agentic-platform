import { create } from "zustand";

interface AddProjectRequestState {
  readonly open: boolean;
  /** What the asker does with the new project once it is added: the home's launch goes on in it (PH13). */
  readonly onAdded: ((projectId: string) => void) | null;
  ask(onAdded?: (projectId: string) => void): void;
  close(): void;
}

/** The chip menu and the home's picker open the Add project dialog through this; the shell's host owns the dialog. */
export const useAddProjectRequest = create<AddProjectRequestState>()((set) => ({
  open: false,
  onAdded: null,
  ask: (onAdded) => set({ open: true, onAdded: onAdded ?? null }),
  close: () => set({ open: false, onAdded: null }),
}));
