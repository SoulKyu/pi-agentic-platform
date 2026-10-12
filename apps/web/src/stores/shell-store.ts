import type { ProjectSummary, ShellSession } from "@pap/contracts";
import { create } from "zustand";
import {
  confirm,
  EMPTY_SHELL,
  failShell,
  optimistic,
  reduceShell,
  rollback,
  type ShellView,
} from "./shell-reducer.ts";

interface ShellStoreState {
  readonly view: ShellView;
  apply(event: unknown): void;
  fail(code: string): void;
  optimistic(commandId: string, change: { sessions?: ShellSession[]; projects?: ProjectSummary[] }): void;
  confirm(commandId: string): void;
  rollback(commandId: string): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The sidebar's sessions and projects (the `shell` stream), the one eager source of session lists (M4R84). */
export const useShellStore = create<ShellStoreState>()((set) => ({
  view: EMPTY_SHELL,
  apply: (event) => set((state) => ({ view: reduceShell(state.view, event) })),
  fail: (code) => set((state) => ({ view: failShell(state.view, code) })),
  optimistic: (commandId, change) => set((state) => ({ view: optimistic(state.view, commandId, change) })),
  confirm: (commandId) => set((state) => ({ view: confirm(state.view, commandId) })),
  rollback: (commandId) => set((state) => ({ view: rollback(state.view, commandId) })),
  reset: () => set({ view: EMPTY_SHELL }),
}));
