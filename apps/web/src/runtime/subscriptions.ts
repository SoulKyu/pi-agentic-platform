import { EventFrame, type Cursor, type StreamName } from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";
import type { RpcClient } from "./rpc.ts";

const CURSOR_CACHE_MS = 5 * 60_000;

export interface Subscriptions {
  subscribe(stream: StreamName, key: string, onEvent: (event: unknown) => void): () => void;
}

interface Entry {
  readonly key: string;
  readonly listeners: Set<(event: unknown) => void>;
  cursor: Cursor | null;
  sub: string | null;
  /** True from the moment a subscribe request leaves until its reply, or its failure, is handled. */
  opening: boolean;
  /** Bumped by every request and every connection loss: an answer from an older one is stale (R11). */
  generation: number;
  expiry: number | null;
}

export function createSubscriptions(connection: Connection, rpc: RpcClient, timers: Timers): Subscriptions {
  const entries = new Map<string, Entry>();
  const bySub = new Map<string, Entry>();
  // The server answers `subscribe` first and sends the snapshot or replay right after, and a socket may
  // hand both over before the reply's promise continues (browsers run microtasks between messages, Node's
  // `ws` does not). Frames of a sub nobody has claimed yet wait here for the reply.
  let early: EventFrame[] = [];

  const opening = () => [...entries.values()].some((entry) => entry.opening);
  const deliver = (entry: Entry, frame: EventFrame) => {
    entry.cursor = { epoch: frame.epoch, seq: frame.seq };
    for (const listener of [...entry.listeners]) listener(frame.event);
  };

  /** Takes the early frames of `sub` (none for `null`), and drops the rest once no request is waiting. */
  const claim = (sub: string | null): EventFrame[] => {
    const mine = early.filter((frame) => frame.sub === sub);
    early = opening() ? early.filter((frame) => frame.sub !== sub) : [];
    return mine;
  };

  const release = (sub: string) => {
    void rpc.call("unsubscribe", { sub }).catch(() => undefined);
  };

  const open = (entry: Entry) => {
    const generation = ++entry.generation;
    entry.opening = true;
    rpc
      .call("subscribe.session", { sessionId: entry.key, ...(entry.cursor ? { after: entry.cursor } : {}) })
      .then(
        ({ sub }) => {
          if (entry.generation !== generation) return;
          entry.opening = false;
          const arrived = claim(sub);
          // Everyone left while the request was in flight and nobody came back: the server still holds it.
          if (entry.listeners.size === 0) return release(sub);
          entry.sub = sub;
          bySub.set(sub, entry);
          for (const frame of arrived) deliver(entry, frame);
        },
        () => {
          if (entry.generation !== generation) return;
          entry.opening = false;
          claim(null);
        },
      );
  };

  connection.onFrame((frame) => {
    const parsed = EventFrame.safeParse(frame);
    if (!parsed.success) return;
    const entry = bySub.get(parsed.data.sub);
    if (entry) deliver(entry, parsed.data);
    else if (opening()) early.push(parsed.data);
  });
  connection.onState((state) => {
    if (state === "open") {
      for (const entry of entries.values()) if (entry.listeners.size > 0) open(entry);
      return;
    }
    // The server drops a connection's subscriptions with it, and `sub` ids restart on the next one.
    bySub.clear();
    early = [];
    for (const entry of entries.values()) {
      entry.sub = null;
      entry.opening = false;
      entry.generation++;
    }
  });

  return {
    subscribe(_stream, key, onEvent) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          key,
          listeners: new Set(),
          cursor: null,
          sub: null,
          opening: false,
          generation: 0,
          expiry: null,
        };
        entries.set(key, entry);
      }
      const current = entry;
      if (current.expiry !== null) timers.clear(current.expiry);
      current.expiry = null;
      const first = current.listeners.size === 0;
      current.listeners.add(onEvent);
      // A request still in flight from a listener that just left is reused: it answers to this one.
      if (first && !current.opening && connection.state === "open") open(current);
      let listening = true;
      return () => {
        if (!listening) return;
        listening = false;
        current.listeners.delete(onEvent);
        if (current.listeners.size > 0) return;
        if (current.sub !== null) {
          bySub.delete(current.sub);
          release(current.sub);
          current.sub = null;
        }
        current.expiry = timers.set(() => entries.delete(current.key), CURSOR_CACHE_MS);
      };
    },
  };
}
