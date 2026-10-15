import { create } from "zustand";

/** What the home's Trigger launch hands a new trigger's editor (§3.1): the name and the prompt. */
export interface TriggerPrefill {
  readonly name: string;
  readonly prompt: string;
}

interface TriggerPrefillState {
  /** By project id: the editor of `new:<project id>` reads its own. */
  readonly items: Readonly<Record<string, TriggerPrefill>>;
  put(projectId: string, prefill: TriggerPrefill): void;
  /** The waiting prefill, left in place: pure, so a state initializer may call it (StrictMode calls those twice). */
  peek(projectId: string): TriggerPrefill | null;
  /** Forgets it once the editor holds it. */
  drop(projectId: string): void;
}

/** The home cannot reach the trigger editor (features never import each other): the shell wires both to this. */
export const useTriggerPrefill = create<TriggerPrefillState>()((set, get) => ({
  items: {},
  put: (projectId, prefill) => set({ items: { ...get().items, [projectId]: prefill } }),
  peek: (projectId) => (Object.hasOwn(get().items, projectId) ? (get().items[projectId] ?? null) : null),
  drop: (projectId) =>
    set({ items: Object.fromEntries(Object.entries(get().items).filter(([id]) => id !== projectId)) }),
}));
