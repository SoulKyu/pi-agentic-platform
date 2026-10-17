import { create } from "zustand";
import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { type AgentsView, EMPTY_AGENTS, reduceAgents } from "./agents-reducer.ts";

interface AgentsStoreState {
  readonly view: AgentsView;
  apply(event: unknown): void;
  /** The daemon refused the stream; the next snapshot clears it. */
  fail(code: RpcErrorCode): void;
  /** Sign-out: the next account starts from nothing (MC34). */
  reset(): void;
}

/** The owner's agents and what they wait for (the `agents` stream): the rail's feed. Eager, so the rail is live. */
export const useAgentsStore = create<AgentsStoreState>()((set) => ({
  view: EMPTY_AGENTS,
  apply: (event) => set((state) => ({ view: reduceAgents(state.view, event) })),
  fail: (code) => set((state) => ({ view: { ...state.view, failed: code } })),
  reset: () => set({ view: EMPTY_AGENTS }),
}));

/** Reads one part of the view; the component re-renders only when that part changes. */
export const useAgents = <T>(selector: (view: AgentsView) => T): T =>
  useAgentsStore((state) => selector(state.view));

/** The one listener of the `agents` stream while the shell is mounted. Its key is local: the stream is the caller's. */
export function feedAgents(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "agents",
    "me",
    (event) => useAgentsStore.getState().apply(event),
    (code) => {
      useAgentsStore.getState().fail(code);
      onError?.(code);
    },
  );
}
