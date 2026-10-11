import type { Connection, ConnectionState } from "./connection.ts";

export function fakeConnection(initial: ConnectionState = "open") {
  let state = initial;
  const frameListeners = new Set<(frame: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const connection: Connection = {
    get state() {
      return state;
    },
    start: () => {},
    stop: () => {},
    send: (frame) => {
      sent.push(frame as Record<string, unknown>);
      return state === "open";
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onState: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    nudge: () => {},
  };
  return {
    connection,
    sent,
    deliver: (frame: unknown) => {
      for (const listener of [...frameListeners]) listener(frame);
    },
    setState: (next: ConnectionState) => {
      state = next;
      for (const listener of [...stateListeners]) listener(next);
    },
  };
}
