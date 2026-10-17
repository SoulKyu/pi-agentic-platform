import { vi } from "vitest";
import { registerServiceWorker, type SwScope } from "./sw.ts";

export const ORIGIN = "https://pap.test";
export const ID = "AbCdEfGhIjKlMnOpQrStUv";

const keyOf = (request: { url: string } | string): string => {
  const url = new URL(typeof request === "string" ? request : request.url, ORIGIN);
  return url.pathname + url.search;
};

/** A Response whose `type` is "basic", as the browser gives for a same-origin fetch (`new Response` is "default"). */
export function basic(body: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

export class FakeCache {
  readonly store = new Map<string, Response>();
  readonly puts: string[] = [];
  readonly addAllCalls: Array<Array<{ url: string; cache: string; redirect: string }>> = [];
  match(request: { url: string } | string): Promise<Response | undefined> {
    return Promise.resolve(this.store.get(keyOf(request))?.clone());
  }
  put(request: { url: string } | string, response: Response): Promise<void> {
    this.puts.push(keyOf(request));
    this.store.set(keyOf(request), response);
    return Promise.resolve();
  }
  async addAll(requests: Request[]): Promise<void> {
    this.addAllCalls.push(
      requests.map((request) => ({ url: request.url, cache: request.cache, redirect: request.redirect })),
    );
    const responses = await Promise.all(requests.map((request) => fetch(request)));
    responses.forEach((response, index) => {
      if (!response.ok) throw new TypeError("addAll: bad response");
      this.store.set(keyOf(requests[index] as Request), response);
    });
  }
}

export class FakeCaches {
  readonly all = new Map<string, FakeCache>();
  open(name: string): Promise<FakeCache> {
    const cache = this.all.get(name) ?? new FakeCache();
    this.all.set(name, cache);
    return Promise.resolve(cache);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.all.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.all.delete(name));
  }
  /** The browser's CacheStorage.match searches every cache: a worker must never use it. */
  async match(request: { url: string } | string): Promise<Response | undefined> {
    for (const cache of this.all.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

export interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}
export const client = (url: string): FakeClient => ({
  url,
  focus: vi.fn(() => Promise.resolve()),
  postMessage: vi.fn(),
});

export interface Fired {
  waits: Promise<unknown>[];
  response: Promise<Response> | Response | undefined;
  respondWith: ReturnType<typeof vi.fn>;
  done(): Promise<unknown[]>;
}

export function bootWorker(buildId: string, shell: readonly string[]) {
  vi.stubGlobal("__BUILD_ID__", buildId);
  vi.stubGlobal("__SHELL__", shell);
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const windows: FakeClient[] = [];
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const scope = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve([...windows])),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
    registration: {
      showNotification: vi.fn((title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      }),
    },
  };
  registerServiceWorker(scope as unknown as SwScope);
  function fire(type: string, props: Record<string, unknown> = {}): Fired {
    const waits: Promise<unknown>[] = [];
    const respondWith = vi.fn();
    const event = { ...props, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith };
    for (const listener of listeners.get(type) ?? []) listener(event);
    return {
      waits,
      respondWith,
      get response() {
        return respondWith.mock.calls[0]?.[0] as Promise<Response> | Response | undefined;
      },
      done: () => Promise.all(waits),
    };
  }
  const fetchEvent = (path: string, mode = "cors", method = "GET") =>
    fire("fetch", { request: { method, mode, url: new URL(path, ORIGIN).href } });
  return { scope, windows, shown, fire, fetchEvent };
}

export type Worker = ReturnType<typeof bootWorker>;

/** The network: body is the path itself so a test can tell which build served it. */
export function stubNetwork(impl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((input: { url: string } | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    return (impl ?? ((u: string) => Promise.resolve(basic(`net:${new URL(u).pathname}`))))(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function freshCaches(): FakeCaches {
  const storage = new FakeCaches();
  vi.stubGlobal("caches", storage);
  return storage;
}

export const SHELL = [
  "/",
  "/index.html",
  "/assets/index-a.js",
  "/assets/lazy-a.js",
  "/favicon.svg",
  "/manifest.webmanifest",
];
