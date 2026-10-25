import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePwaEnv, settled } from "../../testing/pwa-env.ts";
import { usePwa } from "../../stores/pwa.ts";
import { applyUpdate, registerServiceWorker, watchStaleChunks } from "./sw-register.ts";

const OPEN_ID = "/n/AAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

const hidden = (page: ReturnType<typeof fakePwaEnv>) => {
  page.doc.visibilityState = "hidden";
};
const becomeVisible = (page: ReturnType<typeof fakePwaEnv>) => {
  page.doc.visibilityState = "visible";
  page.doc.dispatchEvent(new Event("visibilitychange"));
};

describe("registration (M12R16)", () => {
  it("registers /sw.js with scope / and updateViaCache none in a secure production page", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    expect(page.container.registered).toEqual([
      { url: "/sw.js", options: { scope: "/", updateViaCache: "none" } },
    ]);
  });

  it("never registers in dev, over http, or when serviceWorker is absent", async () => {
    for (const over of [{ production: false }, { secure: false }, { container: undefined }]) {
      const page = fakePwaEnv(over);
      registerServiceWorker(page.env);
      await settled();
      expect(page.container.registered, JSON.stringify(over)).toEqual([]);
    }
  });
});

describe("the update flow (M12R30)", () => {
  it("sets updateReady when a new worker installs under a controller", async () => {
    const page = fakePwaEnv();
    page.container.controller = {};
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.found().become("installed");
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("stays silent on a first install (no controller)", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.found().become("installed");
    expect(usePwa.getState().updateReady).toBe(false);
  });

  it("stays silent on a first install the page is claimed by before installed is seen (WebKit)", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    const first = page.container.registration.found();
    page.container.controller = {};
    first.become("installed");
    expect(usePwa.getState().updateReady).toBe(false);
  });

  it("picks up a worker that was already waiting when the page loaded", async () => {
    const page = fakePwaEnv();
    page.container.controller = {};
    const waiting = page.container.registration.found();
    waiting.state = "installed";
    page.container.registration.waiting = waiting;
    page.container.registration.installing = null;
    registerServiceWorker(page.env);
    await settled();
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("Reload posts skip-waiting, waits for controllerchange, then reloads once", async () => {
    const page = fakePwaEnv();
    page.container.controller = {};
    registerServiceWorker(page.env);
    await settled();
    const worker = page.container.registration.found();
    page.container.registration.waiting = worker;
    worker.become("installed");

    applyUpdate();
    expect(worker.posted).toEqual([{ type: "skip-waiting" }]);
    expect(page.reloads).toEqual([]);
    page.container.dispatchEvent(new Event("controllerchange"));
    page.container.dispatchEvent(new Event("controllerchange"));
    expect(page.reloads).toHaveLength(1);
  });

  it("does not reload on the controllerchange of a first install (clients.claim)", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.found().become("installed");
    page.container.controller = {};
    page.container.dispatchEvent(new Event("controllerchange"));
    expect(page.reloads).toEqual([]);
  });
});

describe("a worker that cannot install", () => {
  it("shows the failed registration when register() rejects, and does not wait for ready", async () => {
    const page = fakePwaEnv();
    page.container.rejectRegister = true;
    registerServiceWorker(page.env);
    await settled();
    expect(usePwa.getState().registrationFailed).toBe(true);
  });

  it("shows it when the first worker turns redundant without installing (a redirecting proxy)", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.found().become("redundant");
    expect(usePwa.getState().registrationFailed).toBe(true);
    expect(usePwa.getState().updateReady).toBe(false);
  });

  it("does not call a worker replaced after it installed a failure", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    const worker = page.container.registration.found();
    worker.become("installed");
    worker.become("redundant");
    expect(usePwa.getState().registrationFailed).toBe(false);
  });
});

describe("a failed UPDATE install", () => {
  it("keeps the shell quietly: no failed flag, no banner, one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePwaEnv();
    page.container.controller = {};
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.found().become("redundant");
    expect(usePwa.getState().registrationFailed).toBe(false);
    expect(usePwa.getState().updateReady).toBe(false);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("update_install_failed"))).toHaveLength(
      1,
    );
    warn.mockRestore();
  });
});

describe("update checks (M12-RT-07)", () => {
  it("logs one bounded line when update() rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.container.registration.update = () => Promise.reject(new Error("offline"));
    becomeVisible(page);
    await settled();
    expect(warn).toHaveBeenCalledWith("pap: update_check_failed");
    warn.mockRestore();
  });

  it("calls update() after a reconnect, not on the first connection", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.conn.setState("connecting");
    page.conn.setState("open");
    expect(page.container.registration.updates).toBe(0);
    page.conn.setState("waiting");
    page.conn.setState("connecting");
    page.conn.setState("open");
    expect(page.container.registration.updates).toBe(1);
  });

  it("calls update() when the page becomes visible, at most once a minute", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    hidden(page);
    becomeVisible(page);
    expect(page.container.registration.updates).toBe(1);
    page.clock.now += 59_999;
    becomeVisible(page);
    expect(page.container.registration.updates).toBe(1);
    page.clock.now += 1;
    becomeVisible(page);
    expect(page.container.registration.updates).toBe(2);
  });

  it("shares the minute between a reconnect and a visible page", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    page.conn.setState("waiting");
    page.conn.setState("open");
    becomeVisible(page);
    expect(page.container.registration.updates).toBe(1);
  });

  it("ignores a hidden page", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    await settled();
    hidden(page);
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(page.container.registration.updates).toBe(0);
  });
});

describe("vite:preloadError", () => {
  it("sets updateReady and reloads once, not twice", async () => {
    const page = fakePwaEnv();
    watchStaleChunks(page.env);
    await settled();
    page.win.dispatchEvent(new Event("vite:preloadError"));
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(usePwa.getState().updateReady).toBe(true);
    expect(page.reloads).toHaveLength(1);
  });

  it("ignores a chunk the page's own navigation aborted, and acts again once the page is back (bfcache)", () => {
    const page = fakePwaEnv();
    watchStaleChunks(page.env);
    page.win.dispatchEvent(new Event("beforeunload"));
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(usePwa.getState().updateReady).toBe(false);
    expect(page.reloads).toEqual([]);
    page.win.dispatchEvent(new Event("pageshow"));
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("does not reload again in a page that just reloaded (storage guard), but still shows the banner", async () => {
    const first = fakePwaEnv();
    watchStaleChunks(first.env);
    first.win.dispatchEvent(new Event("vite:preloadError"));
    expect(first.reloads).toHaveLength(1);

    const second = fakePwaEnv({ storage: first.env.storage });
    second.clock.now = first.clock.now + 5_000;
    watchStaleChunks(second.env);
    second.win.dispatchEvent(new Event("vite:preloadError"));
    expect(second.reloads).toEqual([]);
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("does not reload when session storage throws, but still shows the banner", () => {
    const page = fakePwaEnv({
      storage: () => {
        throw new Error("blocked");
      },
    });
    watchStaleChunks(page.env);
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(page.reloads).toEqual([]);
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("listens in a plain-http production page too (no worker, same stale chunks)", () => {
    const page = fakePwaEnv({ secure: false });
    watchStaleChunks(page.env);
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(usePwa.getState().updateReady).toBe(true);
  });

  it("reloads once even when the stamp cannot be kept", () => {
    const page = fakePwaEnv({
      secure: false,
      storage: () => {
        throw new Error("blocked");
      },
    });
    watchStaleChunks(page.env);
    applyUpdate();
    applyUpdate();
    expect(page.reloads).toHaveLength(1);
  });

  it("applyUpdate with no waiting worker just reloads", () => {
    const page = fakePwaEnv({ secure: false });
    watchStaleChunks(page.env);
    applyUpdate();
    expect(page.reloads).toHaveLength(1);
  });
});

describe("messages from the worker", () => {
  it("open calls the registered handler with the path", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    const seen: string[] = [];
    usePwa.getState().onOpen((path) => seen.push(path));
    page.container.message({ type: "open", path: OPEN_ID });
    page.container.message({ type: "open", path: "/" });
    expect(seen).toEqual([OPEN_ID, "/"]);
  });

  it("refuses a path that is not / or /n/<id>", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    const seen: string[] = [];
    usePwa.getState().onOpen((path) => seen.push(path));
    for (const path of ["//evil.example", "/n/short", "https://evil.example/", 7, null])
      page.container.message({ type: "open", path });
    page.container.message(null);
    page.container.message("open");
    expect(seen).toEqual([]);
  });

  it("resubscribe calls the registered handler", async () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    let calls = 0;
    usePwa.getState().onResubscribe(() => calls++);
    page.container.message({ type: "resubscribe" });
    expect(calls).toBe(1);
  });

  it("a message with no handler is dropped without an error", () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    expect(() => page.container.message({ type: "resubscribe" })).not.toThrow();
  });
});

describe("calling twice with the same page", () => {
  it("adds no second set of listeners and registers once", async () => {
    const page = fakePwaEnv();
    const added = vi.spyOn(page.win, "addEventListener");
    registerServiceWorker(page.env);
    registerServiceWorker(page.env);
    watchStaleChunks(page.env);
    watchStaleChunks(page.env);
    await settled();
    expect(added.mock.calls.filter(([type]) => type === "vite:preloadError")).toHaveLength(1);
    expect(page.container.registered).toHaveLength(1);
    page.win.dispatchEvent(new Event("vite:preloadError"));
    expect(page.reloads).toHaveLength(1);
    const seen: string[] = [];
    usePwa.getState().onOpen((path) => seen.push(path));
    page.container.message({ type: "open", path: "/" });
    expect(seen).toEqual(["/"]);
    becomeVisible(page);
    page.conn.setState("waiting");
    page.conn.setState("open");
    expect(page.container.registration.updates).toBe(1);
  });
});

describe("the install prompt (W6-R16)", () => {
  it("is left to the browser: beforeinstallprompt is not cancelled", () => {
    const page = fakePwaEnv();
    registerServiceWorker(page.env);
    const prompt = new Event("beforeinstallprompt", { cancelable: true });
    page.win.dispatchEvent(prompt);
    expect(prompt.defaultPrevented).toBe(false);
  });
});
