import { reportClientIssue } from "../../lib/report.ts";
import { usePwa } from "../../stores/pwa.ts";
import type { Connection } from "../../runtime/connection.ts";
import { getRuntime } from "../../runtime/index.ts";

interface SwWorker extends EventTarget {
  readonly state: string;
  postMessage(message: unknown): void;
}
interface SwRegistration extends EventTarget {
  readonly installing: SwWorker | null;
  readonly waiting: SwWorker | null;
  update(): Promise<unknown>;
}
interface SwContainer extends EventTarget {
  readonly controller: unknown;
  register(url: string, options: { scope: string; updateViaCache: "none" }): Promise<SwRegistration>;
}

/** Everything the page hands in, so a test drives each of them. */
export interface PwaEnv {
  readonly production: boolean;
  readonly secure: boolean;
  readonly container: SwContainer | undefined;
  readonly connection: Pick<Connection, "onState">;
  readonly win: EventTarget;
  readonly doc: EventTarget & { readonly visibilityState: string };
  now(): number;
  storage(): Pick<Storage, "getItem" | "setItem"> | null;
  reload(): void;
}

const MINUTE = 60_000;
const RELOAD_KEY = "pap.sw.reloaded";
const OPEN_PATH = /^(?:\/|\/n\/[A-Za-z0-9_-]{22})$/;

/** What one page keeps between calls. One per env, so a second call for the same env finds its work already done. */
interface Session {
  readonly env: PwaEnv;
  registration: SwRegistration | null;
  lastCheck: number;
  reloading: boolean;
  armed: boolean;
  staleWatched: boolean;
  registered: boolean;
}

const sessions = new WeakMap<PwaEnv, Session>();
let current: Session | null = null;

function sessionOf(env: PwaEnv): Session {
  let session = sessions.get(env);
  if (!session) {
    session = {
      env,
      registration: null,
      lastCheck: -Infinity,
      reloading: false,
      armed: false,
      staleWatched: false,
      registered: false,
    };
    sessions.set(env, session);
  }
  current = session;
  return session;
}

export function browserEnv(): PwaEnv {
  return {
    production: import.meta.env.PROD,
    secure: window.isSecureContext,
    container: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    // Read only when the worker registers, so building the env at boot does not build the runtime.
    get connection() {
      return getRuntime().connection;
    },
    win: window,
    doc: document,
    now: () => Date.now(),
    storage: () => {
      try {
        return sessionStorage;
      } catch {
        return null;
      }
    },
    reload: () => location.reload(),
  };
}

function reload(session: Session): void {
  if (session.reloading) return;
  session.reloading = true;
  const { env } = session;
  try {
    env.storage()?.setItem(RELOAD_KEY, String(env.now()));
  } catch {
    // the stamp only guards the automatic path
  }
  env.reload();
}

/** An automatic reload (a lazy chunk is gone): once a minute at most, and never when the guard cannot be kept. */
function reloadOnce(session: Session): void {
  const { env } = session;
  try {
    const store = env.storage();
    if (!store) return;
    const last = Number(store.getItem(RELOAD_KEY));
    if (last > 0 && env.now() - last < MINUTE) return;
  } catch {
    return;
  }
  reload(session);
}

function checkForUpdate(session: Session): void {
  const now = session.env.now();
  if (!session.registration || now - session.lastCheck < MINUTE) return;
  session.lastCheck = now;
  try {
    void Promise.resolve(session.registration.update()).catch(() => reportClientIssue("update_check_failed"));
  } catch {
    reportClientIssue("update_check_failed");
  }
}

/** The banner's Reload. The page reloads only after the new worker took control, and only after this click. */
export function applyUpdate(): void {
  const session = current;
  if (!session) return;
  const waiting = session.registration?.waiting;
  const { container } = session.env;
  if (!waiting || !container) return reload(session);
  if (!session.armed) {
    session.armed = true;
    container.addEventListener("controllerchange", () => reload(session), { once: true });
  }
  waiting.postMessage({ type: "skip-waiting" });
}

function watch(container: SwContainer, worker: SwWorker | null): void {
  if (!worker) return;
  let installed = false;
  // An update is a worker found while the page is controlled. Read now: WebKit can let a first worker claim the page
  // before its `installed` statechange arrives, and a first install is silent.
  const update = Boolean(container.controller);
  const look = () => {
    if (worker.state === "installed") {
      installed = true;
      usePwa.getState().setRegistrationFailed(false);
      if (update) usePwa.getState().markUpdateReady();
    } else if (worker.state === "redundant" && !installed) {
      // Never installed. With no controller there is no worker at all and no `ready` will come; with one, the
      // current shell keeps working and the next check retries.
      if (container.controller) reportClientIssue("update_install_failed");
      else usePwa.getState().setRegistrationFailed(true);
    }
  };
  worker.addEventListener("statechange", look);
  look();
}

function onMessage(event: Event): void {
  const data: unknown = (event as MessageEvent).data;
  if (typeof data !== "object" || data === null) return;
  const { type, path } = data as { type?: unknown; path?: unknown };
  const state = usePwa.getState();
  if (type === "open" && typeof path === "string" && OPEN_PATH.test(path)) state.openHandler?.(path);
  else if (type === "resubscribe") state.resubscribeHandler?.();
}

/**
 * A lazy chunk that is gone after a rebuild: the banner, and one reload when the guard allows. Called at boot, before
 * the idle registration, and also useful on plain http where no worker exists.
 */
export function watchStaleChunks(env: PwaEnv): void {
  const session = sessionOf(env);
  if (!env.production || session.staleWatched) return;
  session.staleWatched = true;
  env.win.addEventListener("vite:preloadError", () => {
    usePwa.getState().markUpdateReady();
    reloadOnce(session);
  });
}

/** Production and secure contexts only (M12R16). Never awaited: a worker that cannot install must not block the page. */
export function registerServiceWorker(env: PwaEnv): void {
  const session = sessionOf(env);
  const { container } = env;
  if (!env.production || !env.secure || !container || session.registered) return;
  session.registered = true;
  // `beforeinstallprompt` is left alone (W6-R16): there is no install button in M12, so the browser shows its own install UI.
  container.addEventListener("message", onMessage);
  // An open or resumed PWA never navigates, so the browser would not look for a new worker (M12-RT-07).
  let sawWaiting = false;
  env.connection.onState((state) => {
    if (state === "waiting") sawWaiting = true;
    else if (state === "open" && sawWaiting) {
      sawWaiting = false;
      checkForUpdate(session);
    }
  });
  env.doc.addEventListener("visibilitychange", () => {
    if (env.doc.visibilityState === "visible") checkForUpdate(session);
  });
  container.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(
    (registration) => {
      session.registration = registration;
      registration.addEventListener("updatefound", () => watch(container, registration.installing));
      watch(container, registration.installing);
      if (registration.waiting && container.controller) usePwa.getState().markUpdateReady();
    },
    () => usePwa.getState().setRegistrationFailed(true),
  );
}
