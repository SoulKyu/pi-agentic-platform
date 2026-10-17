import { PROTOCOL_VERSION } from "@pap/contracts";
import { vi } from "vitest";
import {
  createConnection,
  type Connection,
  type ConnectionState,
  type ProbeResult,
  type SocketLike,
} from "./connection.ts";
import type { RpcClient } from "./rpc.ts";
import { createSubscriptions } from "./subscriptions.ts";

export function fakeConnection(initial: ConnectionState = "open") {
  let state = initial;
  let retryAt: number | null = null;
  const frameListeners = new Set<(frame: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const binaryListeners = new Set<(data: ArrayBuffer) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const sentBinary: Uint8Array[] = [];
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
    sendBinary: (bytes) => {
      if (state !== "open") return false;
      sentBinary.push(bytes);
      return true;
    },
    onBinary: (listener) => {
      binaryListeners.add(listener);
      return () => {
        binaryListeners.delete(listener);
      };
    },
    nudge: () => {},
    retry: vi.fn(),
    resume: () => {},
    get retryAt() {
      return retryAt;
    },
    attempt: 0,
  };
  return {
    connection,
    sent,
    sentBinary,
    deliverBinary: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer;
      for (const listener of [...binaryListeners]) listener(copy);
    },
    deliver: (frame: unknown) => {
      for (const listener of [...frameListeners]) listener(frame);
    },
    setRetryAt: (next: number | null) => {
      retryAt = next;
    },
    setState: (next: ConnectionState) => {
      state = next;
      for (const listener of [...stateListeners]) listener(next);
    },
  };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Deferred {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export function subscriptionBed(options: { manual?: boolean; state?: ConnectionState } = {}) {
  const fake = fakeConnection(options.state ?? "open");
  const calls: Array<[string, unknown]> = [];
  const replies: Deferred[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push([method, params]);
      if (!options.manual) {
        return Promise.resolve(method.startsWith("subscribe.") ? { sub: `s${calls.length}` } : { ok: true });
      }
      return new Promise((resolve, reject) => {
        replies[calls.length - 1] = { resolve, reject };
      });
    }),
  } as unknown as RpcClient;
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers = {
    set: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clear: (id: number) => {
      pending.delete(id);
    },
  };
  // Listens to the state before the subscriptions do, like UI code woken by the same notification.
  const hooks: { onOpen: (() => void) | null } = { onOpen: null };
  fake.connection.onState((state) => {
    if (state === "open") hooks.onOpen?.();
  });
  const subscriptions = createSubscriptions(fake.connection, rpc, timers);
  return {
    fake,
    calls,
    replies,
    hooks,
    subscriptions,
    expire: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

class FakeSocket implements SocketLike {
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  binaryType: "blob" | "arraybuffer" = "blob";
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.sent.push(data);
    else this.sentBinary.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  receiveBinary(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

export function connectionBed(
  probe: ProbeResult | (() => Promise<ProbeResult>) = "ok",
  options: { failCreates?: number } = {},
) {
  let failures = options.failCreates ?? 0;
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void; probeDeadline: boolean }>();
  const sockets: FakeSocket[] = [];
  const connection = createConnection({
    url: "ws://localhost/ws?proto=1",
    createSocket: () => {
      if (failures > 0) {
        failures--;
        throw new Error("SecurityError");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    probe: () => {
      // The supervisor sets the probe's deadline timer right before it calls the probe: the newest one.
      const newest = pending.get(nextId - 1);
      if (newest) newest.probeDeadline = true;
      return typeof probe === "function" ? probe() : Promise.resolve(probe);
    },
    timers: {
      set: (fn, ms) => {
        pending.set(nextId, { at: now + ms, fn, probeDeadline: false });
        return nextId++;
      },
      clear: (id) => {
        pending.delete(id);
      },
    },
    random: () => 0.5,
    now: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && pending.has(id)) {
        pending.delete(id);
        timer.fn();
      }
    }
  };
  const latest = () => sockets[sockets.length - 1] as FakeSocket;
  const hello = (protocol = PROTOCOL_VERSION) =>
    latest().receive({ protocol, capabilities: ["rpc"], serverVersion: "0.0.0" });
  return {
    connection,
    sockets,
    advance,
    latest,
    hello,
    // every pending timer but a probe's deadline: retry, dead-peer and stable timers
    delays: () => [...pending.values()].filter((t) => !t.probeDeadline).map((t) => t.at - now),
    timerCount: () => pending.size,
  };
}
