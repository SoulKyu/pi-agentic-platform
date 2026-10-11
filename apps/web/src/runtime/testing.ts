import { vi } from "vitest";
import type { Connection, ConnectionState } from "./connection.ts";
import type { RpcClient } from "./rpc.ts";
import { createSubscriptions } from "./subscriptions.ts";

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
        return Promise.resolve(method === "subscribe.session" ? { sub: `s${calls.length}` } : { ok: true });
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
  const subscriptions = createSubscriptions(fake.connection, rpc, timers);
  return {
    fake,
    calls,
    replies,
    subscriptions,
    expire: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}
