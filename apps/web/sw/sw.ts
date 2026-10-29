// Hand-written service worker (M12R14, M12R28). One classic script: the build strips the types and the `export `
// keywords (apps/web/vite/service-worker.ts). It imports nothing. It never sees a credential and never caches data.
declare const __BUILD_ID__: string;
declare const __SHELL__: readonly string[];
// Only a worker has this global; declared here so the file typechecks under the DOM lib too.
declare const ServiceWorkerGlobalScope: (new () => object) | undefined;

const PREFIX = "pap-shell-";
const ID = /^[A-Za-z0-9_-]{22}$/;
const CLASS_NAMES = ["approval", "failed", "budget", "notify", "done", "reply", "digest", "test"];
const NAV_TIMEOUT_MS = 8_000; // pi-web learned it: a reachable port backed by a dead upstream never answers
// Anything the daemon serves that is not the SPA: never intercepted, never cached.
const NOT_SPA = [
  "/auth",
  "/api",
  "/files",
  "/upload",
  "/hooks",
  "/metrics",
  "/healthz",
  "/ws",
  "/sw.js",
  "/github",
  "/fonts",
];

interface SwEvent {
  waitUntil(work: Promise<unknown>): void;
}
interface SwClient {
  readonly url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface SwEvents {
  install: SwEvent;
  activate: SwEvent;
  message: { data: unknown };
  fetch: { request: Request; respondWith(response: Promise<Response>): void };
  push: SwEvent & { data: { text(): string } | null };
  notificationclick: SwEvent & { notification: { close(): void; data: unknown } };
  pushsubscriptionchange: SwEvent;
}
/** The members this worker uses: structural, so one source typechecks under the DOM and the WebWorker libs. */
export interface SwScope {
  addEventListener<K extends keyof SwEvents>(type: K, listener: (event: SwEvents[K]) => void): void;
  skipWaiting(): Promise<void>;
  location: { origin: string; href: string };
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<readonly SwClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  registration: { showNotification(title: string, options: object): Promise<void> };
}

export function isNotSpa(pathname: string): boolean {
  return NOT_SPA.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
export function isShellPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/favicon.svg" ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/icons/")
  );
}
export type Route = "shell" | "navigation" | "pass";
export function routeOf(request: { method: string; url: string; mode: string }, origin: string): Route {
  if (request.method !== "GET") return "pass";
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "pass";
  }
  if (url.origin !== origin || isNotSpa(url.pathname)) return "pass";
  if (request.mode === "navigate") return "navigation";
  return isShellPath(url.pathname) ? "shell" : "pass";
}
export function cacheable(res: {
  status: number;
  type: string;
  redirected: boolean;
  headers: { get(name: string): string | null };
}): boolean {
  if (res.status !== 200 || res.type !== "basic" || res.redirected) return false;
  const control = (res.headers.get("cache-control") ?? "").toLowerCase();
  return !control.includes("no-store") && !control.includes("private");
}
/** Network first with a deadline; the cached static shell when the network fails, times out or a proxy answers 5xx. Never data. */
export async function navigate(
  request: Request,
  shell: () => Promise<Response | undefined>,
  timeoutMs = NAV_TIMEOUT_MS,
): Promise<Response> {
  const fallback = async () => (await shell()) ?? Response.error();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(request, { signal: controller.signal });
    return res.status >= 500 ? await fallback() : res;
  } catch {
    return await fallback();
  } finally {
    clearTimeout(timer);
  }
}
export function notificationOf(raw: string | null): {
  title: string;
  options: { body: string; tag?: string; icon: string; badge: string; data: { id: string | null } };
} {
  const base = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" };
  try {
    if (raw === null || raw.length > 2048) throw new Error("size");
    const p = JSON.parse(raw) as Record<string, unknown>;
    const idOk = typeof p.id === "string" && ID.test(p.id);
    if (p.v !== 1 || !idOk || typeof p.cls !== "string" || !CLASS_NAMES.includes(p.cls))
      throw new Error("shape");
    const clip = (v: unknown, n: number) => (typeof v === "string" ? Array.from(v).slice(0, n).join("") : "");
    return {
      title: clip(p.title, 80) || "pap",
      options: { ...base, body: clip(p.body, 200), tag: p.id as string, data: { id: p.id as string } },
    };
  } catch {
    return { title: "pap", options: { ...base, body: "", data: { id: null } } }; // iOS needs a notification for every push
  }
}
export function clickPath(id: unknown): string {
  return typeof id === "string" && ID.test(id) ? `/n/${id}` : "/";
}

export function registerServiceWorker(scope: SwScope): void {
  const current = `${PREFIX}${__BUILD_ID__}`;
  const shell = __SHELL__; // read once: this worker's list is fixed at build time
  scope.addEventListener("install", (event) => {
    // Absolute URLs: a Request needs a base outside a browser page, and it is the same URL the browser resolves.
    // Hashed, immutable assets may come from the HTTP cache (a rebuild re-downloads only the new ones); everything else
    // is revalidated. A redirect fails the install instead of caching a redirected answer.
    const requests = shell.map(
      (u) =>
        new Request(new URL(u, scope.location.href).href, {
          cache: u.startsWith("/assets/") ? "default" : "reload",
          redirect: "error",
        }),
    );
    event.waitUntil(caches.open(current).then((cache) => cache.addAll(requests)));
  }); // a failed precache fails the install: the old worker stays in charge, nothing is stranded
  scope.addEventListener("activate", (event) => {
    // Only the NEW worker's activate deletes the old shell caches: until then the old shell still has its own lazy chunks.
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== current).map((k) => caches.delete(k))),
        )
        .then(() => scope.clients.claim()),
    );
  });
  scope.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type === "skip-waiting") void scope.skipWaiting(); // only after the owner accepted the update banner
  });
  scope.addEventListener("fetch", (event) => {
    const route = routeOf(event.request, scope.location.origin);
    if (route === "pass") return; // network only, the worker never sees the response
    if (route === "shell") {
      event.respondWith(
        caches.open(current).then(async (cache) => {
          // this worker's own versioned cache, never caches.match (that searches a newer waiting worker's cache too)
          const hit = await cache.match(event.request);
          if (hit) return hit;
          const res = await fetch(event.request);
          const path = new URL(event.request.url).pathname;
          if ((path.startsWith("/assets/") || path.startsWith("/icons/")) && cacheable(res))
            await cache.put(event.request, res.clone());
          return res;
        }),
      );
      return;
    }
    event.respondWith(
      navigate(event.request, () => caches.open(current).then((cache) => cache.match("/index.html"))),
    );
  });
  scope.addEventListener("push", (event) => {
    const { title, options } = notificationOf(event.data ? event.data.text() : null);
    event.waitUntil(scope.registration.showNotification(title, options));
  });
  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = new URL(
      clickPath((event.notification.data as { id?: unknown } | null)?.id),
      scope.location.origin,
    );
    if (target.origin !== scope.location.origin) return; // cannot happen by construction; kept as the last line of defence
    event.waitUntil(
      scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (all) => {
        // A window on an SPA path: a tab sitting on /auth/... or /files/... is not the app.
        const open = all.find((c) => {
          const url = new URL(c.url);
          return url.origin === scope.location.origin && !isNotSpa(url.pathname);
        });
        if (open) {
          try {
            await open.focus();
            open.postMessage({ type: "open", path: target.pathname });
            return;
          } catch {
            // focus refused (a stale client): open a fresh window below
          }
        }
        await scope.clients.openWindow(target.href);
      }),
    );
  });
  scope.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil(
      scope.clients
        .matchAll({ type: "window" })
        .then((all) => all.forEach((c) => c.postMessage({ type: "resubscribe" }))),
    ); // the page re-subscribes with its cookie; the worker holds no credential
  });
}

if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope)
  registerServiceWorker(self as unknown as SwScope);
