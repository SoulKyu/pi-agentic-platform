import { create } from "zustand";

/**
 * What an agent's thread asks of its composer (M11R123): `@<Name> text` goes to another agent instead of to the thread.
 * The agent tab registers a port for its thread's session; a plain session has none, so nothing is ever handed off
 * there. Features never import each other, so the two sides share this file.
 */
export interface HandOffPort {
  /** The other agents' names, for the `@` menu (the thread's own agent is not in it). */
  readonly names: readonly string[];
  /** True when the text was taken as a hand-off (the composer clears its draft); false: it is a normal message. */
  handOff(text: string): boolean;
}

interface HandOffPortsState {
  readonly ports: Readonly<Record<string, HandOffPort>>;
  /** Registers the port of a session; the returned function takes it away (a newer port of the same session stays). */
  register(sessionId: string, port: HandOffPort): () => void;
}

export const useHandOffPorts = create<HandOffPortsState>()((set, get) => ({
  ports: {},
  register(sessionId, port) {
    set({ ports: { ...get().ports, [sessionId]: port } });
    return () => {
      if (get().ports[sessionId] !== port) return;
      set({ ports: Object.fromEntries(Object.entries(get().ports).filter(([id]) => id !== sessionId)) });
    };
  },
}));
