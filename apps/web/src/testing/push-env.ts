import { vi } from "vitest";
import type { Timers } from "../runtime/connection.ts";
import type {
  PushEnv,
  PushRegistrationLike,
  PushSubscriptionLike,
} from "../features/notifications/push-client.ts";
import type { PushSupport } from "../features/notifications/support.ts";

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const SERVER_KEY = new Uint8Array(65).fill(4);
export const SERVER_PUBLIC_KEY = encode(SERVER_KEY);
export const OTHER_KEY = new Uint8Array(65).fill(7);
export const P256DH = encode(new Uint8Array(65).fill(9));
export const AUTH = encode(new Uint8Array(16).fill(3));

export class FakeSubscription implements PushSubscriptionLike {
  unsubscribed = 0;
  log: string[] = [];
  readonly endpoint = "https://push.example.test/abcdef0123456789";
  readonly options: { applicationServerKey: ArrayBuffer | null };
  constructor(key: Uint8Array | null = SERVER_KEY, log: string[] = []) {
    this.log = log;
    this.options = { applicationServerKey: key ? (key.slice().buffer as ArrayBuffer) : null };
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: P256DH, auth: AUTH } };
  }
  unsubscribe() {
    this.unsubscribed++;
    this.log.push("unsubscribe");
    return Promise.resolve(true);
  }
}

/** The page's push objects, driven by the test: one registration whose push manager holds at most one subscription. */
export function fakePushEnv(over: Partial<PushEnv> = {}, existing: FakeSubscription | null = null) {
  const log: string[] = [];
  const state = { sub: existing, permission: "default" as NotificationPermission | undefined };
  const subscribeCalls: unknown[] = [];
  const registration: PushRegistrationLike = {
    pushManager: {
      // An unsubscribed subscription is gone from the manager, as in a browser.
      getSubscription: vi.fn(() =>
        Promise.resolve(state.sub && state.sub.unsubscribed === 0 ? state.sub : null),
      ),
      subscribe: vi.fn((options: unknown) => {
        subscribeCalls.push(options);
        log.push("subscribe");
        state.sub = new FakeSubscription(SERVER_KEY, log);
        return Promise.resolve(state.sub);
      }),
    },
  };
  const requestPermission = vi.fn(() => {
    state.permission = "granted";
    return Promise.resolve("granted" as NotificationPermission);
  });
  const env: PushEnv = {
    support: (): PushSupport => "supported",
    permission: () => state.permission,
    requestPermission,
    current: () => Promise.resolve(registration),
    ready: () => Promise.resolve(registration),
    locale: () => "fr",
    label: () => "iPhone",
    ...over,
  };
  if (existing) existing.log = log;
  return { env, log, state, subscribeCalls, registration, requestPermission };
}

/** Timers a test fires by hand, in order. */
export function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clear: (id) => void pending.delete(id),
  };
  return {
    timers,
    pending: () => [...pending.values()].map((entry) => entry.ms),
    fireNext: () => {
      const first = [...pending][0];
      if (!first) return false;
      pending.delete(first[0]);
      first[1].fn();
      return true;
    },
  };
}
