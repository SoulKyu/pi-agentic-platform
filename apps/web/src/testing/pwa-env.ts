import { fakeConnection } from "../runtime/testing.ts";
import type { PwaEnv } from "../features/pwa/index.ts";

export class FakeWorker extends EventTarget {
  state = "installing";
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

export class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  updates = 0;
  update(): Promise<void> {
    this.updates++;
    return Promise.resolve();
  }
  /** The browser found a new worker file: `updatefound`, then the worker installs. */
  found(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    return worker;
  }
}

export class FakeContainer extends EventTarget {
  controller: unknown = null;
  readonly registration = new FakeRegistration();
  readonly registered: Array<{ url: string; options: unknown }> = [];
  rejectRegister = false;
  register(url: string, options: unknown): Promise<FakeRegistration> {
    this.registered.push({ url, options });
    return this.rejectRegister ? Promise.reject(new Error("redirect")) : Promise.resolve(this.registration);
  }
  message(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}

/** A page for `registerServiceWorker`: every browser object is a fake the test drives. */
export function fakePwaEnv(over: Partial<PwaEnv> = {}) {
  const container = new FakeContainer();
  const win = new EventTarget();
  const doc = new FakeDocument();
  const conn = fakeConnection("open");
  const clock = { now: 1_000_000 };
  const store = new Map<string, string>();
  const reloads: number[] = [];
  const env: PwaEnv = {
    production: true,
    secure: true,
    container: container as unknown as PwaEnv["container"],
    connection: conn.connection,
    win,
    doc,
    now: () => clock.now,
    storage: () => ({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    }),
    reload: () => void reloads.push(clock.now),
    ...over,
  };
  return { env, container, win, doc, conn, clock, store, reloads };
}

export const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
