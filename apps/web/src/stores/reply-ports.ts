import { create } from "zustand";

export interface PathScope {
  /** Relative paths resolve against it: the session's cwd; `/agent/home` in an agent thread. */
  readonly base: string;
  /** Absolute paths link only at or under one of these. */
  readonly roots: readonly string[];
  /** The Files pane's root: a link's mapped target must be at or under it. */
  readonly filesRoot: string;
  /** In an agent thread, `/agent/...` maps to `/agents/<agentId>/...`. */
  readonly agentId: string | null;
}

export type TerminalOutcome = "typed" | "multiline" | "timeout" | "unavailable" | "too_long" | "busy";

export interface ReplyPort {
  readonly scope: PathScope;
  openFile(path: string, line: number | null): void;
  /** Absent where the session has no terminal. */
  readonly toTerminal?: (text: string) => Promise<TerminalOutcome>;
}

interface ReplyPortsState {
  readonly ports: Readonly<Record<string, ReplyPort>>;
  /** One port per session; the remover removes this port only, never a newer one of the same session. */
  register(sessionId: string, port: ReplyPort): () => void;
  reset(): void;
}

/** What a reply may do for its session: open a path in Files, type into the terminal. A mounted tab registers one. */
export const useReplyPorts = create<ReplyPortsState>()((set, get) => ({
  ports: {},
  register(sessionId, port) {
    set({ ports: { ...get().ports, [sessionId]: port } });
    return () => {
      if (get().ports[sessionId] !== port) return;
      set({ ports: Object.fromEntries(Object.entries(get().ports).filter(([id]) => id !== sessionId)) });
    };
  },
  reset: () => set({ ports: {} }),
}));
