import { EventFrame, type Cursor, type StreamName } from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";
import { RpcError, type RpcClient, type RpcErrorCode } from "./rpc.ts";

const CURSOR_CACHE_MS = 5 * 60_000;
// The most a server replays is 128 events and a snapshot; this is far above that.
const EARLY_FRAMES_MAX = 256;

export interface Subscriptions {
  /**
   * Listens to one key of a stream. Every listener of a key shares one server stream, so a listener that
   * joins late gets the live events only, never the snapshot the first one got: keep what the events
   * build (the session's messages, status) outside the listener, in a store keyed by `key`, and run one
   * feed per key. The cursor outlives the last listener by 5 minutes, so a quick return resumes from it.
   *
   * `onError` hears why the server refused the subscription (`not_found`, `capacity`, `forbidden`,
   * `internal`, ...). It is not called for `connection_lost` or `offline`: the next connection
   * subscribes again by itself. A throwing listener or `onError` does not stop the others.
   *
   * Never subscribe again from `onError`: nothing backs off, so retrying `not_found` or `capacity` from
   * the handler is a hot loop against the server. Show the error; the next connection, or the next
   * `subscribe` call (a new mount), tries again.
   */
  subscribe(
    stream: StreamName,
    key: string,
    onEvent: (event: unknown) => void,
    onError?: (code: RpcErrorCode) => void,
  ): () => void;
  /**
   * Asks the server for a fresh snapshot of a key that has listeners (nothing otherwise): the cursor is
   * dropped, and while the socket is open the current sub is released and a new one requested; while it
   * is not, the reconnect asks without a cursor. An answer to the request it replaces is released.
   */
  resync(stream: StreamName, key: string): void;
}

/** How each stream is asked for (M4R78). The `shell` stream is the caller's own: its key is a local name. */
const OPENERS: {
  readonly [S in StreamName]: (rpc: RpcClient, key: string, after: Cursor | null) => Promise<{ sub: string }>;
} = {
  session: (rpc, key, after) =>
    rpc.call("subscribe.session", { sessionId: key, ...(after ? { after } : {}) }),
  shell: (rpc, _key, after) => rpc.call("subscribe.shell", after ? { after } : {}),
  // The key is the repository root (M8R44).
  vcs: (rpc, key, after) => rpc.call("subscribe.vcs", { root: key, ...(after ? { after } : {}) }),
  // The caller's own terminals, like `shell`: the key is a local name (M8R65).
  terminal: (rpc, _key, after) => rpc.call("subscribe.terminal", after ? { after } : {}),
  login: (rpc, key, after) => rpc.call("subscribe.login", { flowId: key, ...(after ? { after } : {}) }),
  // The caller's own lanes, like `shell` (M9R3).
  lane: (rpc, _key, after) => rpc.call("subscribe.lane", after ? { after } : {}),
  // The caller's own board, like `shell`: the key is a local name (M10R43).
  tasks: (rpc, _key, after) => rpc.call("subscribe.tasks", after ? { after } : {}),
  // The caller's own Inbox, like `shell`: the key is a local name (M10R50).
  inbox: (rpc, _key, after) => rpc.call("subscribe.inbox", after ? { after } : {}),
  // The caller's own quota limits and spend, like `shell`: the key is a local name (M10R107).
  usage: (rpc, _key, after) => rpc.call("subscribe.usage", after ? { after } : {}),
  // The caller's own agents, like `shell`: the key is a local name (M11R63).
  agents: (rpc, _key, after) => rpc.call("subscribe.agents", after ? { after } : {}),
};

interface Listener {
  readonly onEvent: (event: unknown) => void;
  readonly onError: ((code: RpcErrorCode) => void) | undefined;
}

interface Entry {
  readonly stream: StreamName;
  readonly key: string;
  readonly listeners: Set<Listener>;
  cursor: Cursor | null;
  sub: string | null;
  /** True from the moment a subscribe request leaves until its reply, or its failure, is handled. */
  opening: boolean;
  /** Bumped by every request and every connection loss: an answer from an older one is stale (R11). */
  generation: number;
  expiry: number | null;
}

// A listener belongs to the UI: whatever it throws is reported, not allowed to cut the others short.
function isolated(call: () => void): void {
  try {
    call();
  } catch (error) {
    console.error("subscription listener failed", error);
  }
}

export function createSubscriptions(connection: Connection, rpc: RpcClient, timers: Timers): Subscriptions {
  const entries = new Map<string, Entry>();
  const bySub = new Map<string, Entry>();
  // The server answers `subscribe` first and sends the snapshot or replay right after, and a socket may
  // hand both over before the reply's promise continues (browsers run microtasks between messages, Node's
  // `ws` does not). Frames of a sub nobody has claimed yet wait here for the reply.
  let early: EventFrame[] = [];
  // Counts the connections that have ended: a sub id only means something on the connection it came from.
  let link = 0;

  const opening = () => [...entries.values()].some((entry) => entry.opening);
  const deliver = (entry: Entry, frame: EventFrame) => {
    entry.cursor = { epoch: frame.epoch, seq: frame.seq };
    for (const listener of [...entry.listeners]) isolated(() => listener.onEvent(frame.event));
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

  const fail = (entry: Entry, error: unknown) => {
    const code: RpcErrorCode = error instanceof RpcError ? error.code : "internal";
    // The next connection retries these on its own; the listener has nothing to show for them.
    if (code === "connection_lost" || code === "offline") return;
    for (const listener of [...entry.listeners]) {
      const { onError } = listener;
      if (onError) isolated(() => onError(code));
    }
  };

  const open = (entry: Entry) => {
    const generation = ++entry.generation;
    const connected = link;
    entry.opening = true;
    OPENERS[entry.stream](rpc, entry.key, entry.cursor).then(
      ({ sub }) => {
        if (entry.generation !== generation) {
          // Two requests for the key crossed on this connection (a subscribe made while the open
          // notification was still going out): the newer one serves the listeners, so free this sub.
          claim(sub);
          if (link === connected) release(sub);
          return;
        }
        entry.opening = false;
        const arrived = claim(sub);
        // Everyone left while the request was in flight and nobody came back: the server still holds it.
        if (entry.listeners.size === 0) return release(sub);
        entry.sub = sub;
        bySub.set(sub, entry);
        for (const frame of arrived) deliver(entry, frame);
      },
      (error: unknown) => {
        if (entry.generation !== generation) return;
        entry.opening = false;
        claim(null);
        fail(entry, error);
      },
    );
  };

  connection.onFrame((frame) => {
    const parsed = EventFrame.safeParse(frame);
    if (!parsed.success) return;
    const entry = bySub.get(parsed.data.sub);
    if (entry) deliver(entry, parsed.data);
    else if (opening() && early.length < EARLY_FRAMES_MAX) early.push(parsed.data);
  });
  connection.onState((state) => {
    if (state === "open") {
      for (const entry of entries.values()) if (entry.listeners.size > 0) open(entry);
      return;
    }
    // The server drops a connection's subscriptions with it, and `sub` ids restart on the next one.
    bySub.clear();
    early = [];
    link++;
    for (const entry of entries.values()) {
      entry.sub = null;
      entry.opening = false;
      entry.generation++;
    }
  });

  return {
    resync(stream, key) {
      const entry = entries.get(`${stream}:${key}`);
      if (!entry || entry.listeners.size === 0) return;
      // The next answer must be a fresh snapshot: the cursor goes, now or at the reconnect (M4R79).
      entry.cursor = null;
      if (connection.state !== "open") return;
      if (entry.sub !== null) {
        bySub.delete(entry.sub);
        release(entry.sub);
        entry.sub = null;
      }
      // A request in flight is answered stale by the generation `open` bumps, and released then (R11).
      open(entry);
    },
    subscribe(stream, key, onEvent, onError) {
      const id = `${stream}:${key}`;
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          stream,
          key,
          listeners: new Set(),
          cursor: null,
          sub: null,
          opening: false,
          generation: 0,
          expiry: null,
        };
        entries.set(id, entry);
      }
      const current = entry;
      if (current.expiry !== null) timers.clear(current.expiry);
      current.expiry = null;
      const listener: Listener = { onEvent, onError };
      current.listeners.add(listener);
      // A request still in flight from a listener that just left is reused: it answers to this one. A
      // key whose last request failed is tried again by whoever joins next.
      if (current.sub === null && !current.opening && connection.state === "open") open(current);
      let listening = true;
      return () => {
        if (!listening) return;
        listening = false;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        if (current.sub !== null) {
          bySub.delete(current.sub);
          release(current.sub);
          current.sub = null;
        }
        current.expiry = timers.set(() => entries.delete(id), CURSOR_CACHE_MS);
      };
    },
  };
}
