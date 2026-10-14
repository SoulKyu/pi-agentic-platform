import { HelloFrame, PROTOCOL_VERSION } from "@pap/contracts";

export type ConnectionState = "idle" | "connecting" | "open" | "waiting" | "outdated" | "signed-out";
export type ProbeResult = "ok" | "outdated" | "signed-out" | "offline";

export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  binaryType: "blob" | "arraybuffer";
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface ConnectionDeps {
  readonly url: string;
  createSocket(url: string): SocketLike;
  probe(): Promise<ProbeResult>;
  readonly timers: Timers;
  random(): number;
}

export interface Connection {
  readonly state: ConnectionState;
  start(): void;
  stop(): void;
  send(frame: object): boolean;
  /** Raw bytes to the daemon (terminal frames): false unless the socket is open. */
  sendBinary(bytes: Uint8Array): boolean;
  onFrame(listener: (frame: unknown) => void): () => void;
  /** A binary message, only while open and undecoded (M8R68). */
  onBinary(listener: (data: ArrayBuffer) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  nudge(): void;
}

const DEAD_AFTER_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_AFTER_MS = 10_000;
/** The longest the supervisor waits for the probe: no answer counts as `offline`. */
export const PROBE_DEADLINE_MS = 10_000;

export function backoffDelay(attempt: number, random: number): number {
  return Math.round(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.5 + random / 2));
}

export function createConnection(deps: ConnectionDeps): Connection {
  let state: ConnectionState = "idle";
  let socket: SocketLike | null = null;
  let attempt = 0;
  let stopped = true;
  // Bumped by every connect and stop: a probe that answers after one of them is for a socket that is gone.
  let round = 0;
  const timers: { retry: number | null; dead: number | null; stable: number | null } = {
    retry: null,
    dead: null,
    stable: null,
  };
  // Deadline timers of the probes in flight, so that stop() leaves nothing armed.
  const probeDeadlines = new Set<number>();
  const frameListeners = new Set<(frame: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const binaryListeners = new Set<(data: ArrayBuffer) => void>();

  const clear = (key: keyof typeof timers) => {
    const id = timers[key];
    if (id !== null) deps.timers.clear(id);
    timers[key] = null;
  };
  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  };
  // A closing handshake with a dead peer can take minutes in a browser, so a socket we give up on is
  // detached and replaced at once instead of waiting for its `close` event.
  const detach = (current: SocketLike) => {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // already closed: nothing left to release
    }
  };
  const armDead = () => {
    clear("dead");
    timers.dead = deps.timers.set(() => {
      if (!socket) return;
      const dead = socket;
      detach(dead);
      void onDrop(dead);
    }, DEAD_AFTER_MS);
  };
  // A probe that throws or never answers is the same as a network that is down: without this the
  // supervisor would wait for it forever, with no retry timer armed.
  const probe = (): Promise<ProbeResult> =>
    new Promise((resolve) => {
      const deadline = deps.timers.set(() => {
        probeDeadlines.delete(deadline);
        resolve("offline");
      }, PROBE_DEADLINE_MS);
      probeDeadlines.add(deadline);
      Promise.resolve()
        .then(() => deps.probe())
        .catch((): ProbeResult => "offline")
        .then((result) => {
          if (probeDeadlines.delete(deadline)) deps.timers.clear(deadline);
          resolve(result);
        });
    });
  const applyProbe = (result: ProbeResult): boolean => {
    if (result === "outdated") setState("outdated");
    else if (result === "signed-out") setState("signed-out");
    else return true;
    return false;
  };

  const connect = () => {
    clear("retry");
    round++;
    setState("connecting");
    let current: SocketLike;
    try {
      current = deps.createSocket(deps.url);
    } catch {
      // a refused URL (mixed content, bad scheme) fails like a connection that dropped at once
      socket = null;
      void retryLater();
      return;
    }
    current.binaryType = "arraybuffer";
    socket = current;
    // Armed before the socket opens: a connection that hangs in CONNECTING is as dead as a silent peer.
    armDead();
    current.onerror = () => {};
    current.onclose = () => {
      void onDrop(current);
    };
    current.onmessage = (event) => {
      if (current !== socket) return;
      armDead();
      if (event.data instanceof ArrayBuffer) {
        if (state === "open") for (const listener of [...binaryListeners]) listener(event.data);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (state === "connecting") {
        const hello = HelloFrame.safeParse(frame);
        if (hello.success && hello.data.protocol === PROTOCOL_VERSION) {
          setState("open");
          timers.stable = deps.timers.set(() => {
            attempt = 0;
          }, STABLE_AFTER_MS);
        } else {
          setState("outdated");
          detach(current);
          void onDrop(current);
        }
        return;
      }
      for (const listener of [...frameListeners]) listener(frame);
    };
  };

  const onDrop = async (dropped: SocketLike) => {
    if (dropped !== socket) return;
    socket = null;
    clear("dead");
    clear("stable");
    await retryLater();
  };

  // The probe says why the socket is gone; unless that is final, the next attempt follows the backoff.
  const retryLater = async () => {
    if (stopped || state === "outdated" || state === "signed-out") return;
    setState("waiting");
    const mine = round;
    const result = await probe();
    if (mine !== round || !applyProbe(result)) return;
    timers.retry = deps.timers.set(connect, backoffDelay(attempt++, deps.random()));
  };

  return {
    get state() {
      return state;
    },
    start() {
      // Signed-out is the one end state a start can leave: the caller has signed in again.
      if (!stopped && state !== "signed-out") return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      round++;
      clear("retry");
      clear("dead");
      clear("stable");
      for (const deadline of probeDeadlines) deps.timers.clear(deadline);
      probeDeadlines.clear();
      const current = socket;
      socket = null;
      if (current) detach(current);
      setState("idle");
    },
    send(frame) {
      if (state !== "open" || !socket) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    },
    sendBinary(bytes) {
      if (state !== "open" || !socket) return false;
      try {
        socket.send(bytes);
        return true;
      } catch {
        return false;
      }
    },
    onBinary(listener) {
      binaryListeners.add(listener);
      return () => {
        binaryListeners.delete(listener);
      };
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    nudge() {
      // Foreground or back online: a socket still connecting belongs to the network we just left.
      if (state === "connecting" && socket) {
        detach(socket);
        connect();
        return;
      }
      if (state !== "waiting" || timers.retry === null) return;
      clear("retry");
      const mine = round;
      void probe().then((result) => {
        if (mine === round && applyProbe(result)) connect();
      });
    },
  };
}
