import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basic, bootWorker, freshCaches, SHELL, stubNetwork, type FakeCaches } from "./harness.ts";

let storage: FakeCaches;
beforeEach(() => {
  storage = freshCaches();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("install.precaches-shell-and-fails-closed", () => {
  it("precaches the shell list (index.html and every lazy chunk), without skipWaiting", async () => {
    stubNetwork();
    const worker = bootWorker("b1", SHELL);
    await worker.fire("install").done();
    const cache = storage.all.get("pap-shell-b1");
    // hashed assets may come from the HTTP cache; everything else is revalidated; a redirect fails the install
    expect(cache?.addAllCalls[0]).toEqual(
      SHELL.map((path) => ({
        url: `https://pap.test${path}`,
        cache: path.startsWith("/assets/") ? "default" : "reload",
        redirect: "error",
      })),
    );
    expect(cache?.addAllCalls[0]?.filter((r) => r.cache === "default")).toHaveLength(2);
    expect([...(cache?.store.keys() ?? [])]).toEqual(SHELL);
    expect(worker.scope.skipWaiting).not.toHaveBeenCalled();
  });

  it("a failing precache rejects waitUntil, so the install fails", async () => {
    stubNetwork((url) =>
      Promise.resolve(url.endsWith("/assets/lazy-a.js") ? basic("", { status: 404 }) : basic("ok")),
    );
    const worker = bootWorker("b1", SHELL);
    await expect(worker.fire("install").done()).rejects.toThrow("addAll: bad response");
  });
});

describe("update.old-shell-keeps-its-lazy-chunks (M12-RT-07)", () => {
  it("serves v1 from its own cache while v2 waits, and drops it only when v2 activates", async () => {
    const v1Shell = ["/", "/index.html", "/assets/index-a.js", "/assets/lazy-a.js"];
    const v2Shell = ["/", "/index.html", "/assets/index-b.js", "/assets/lazy-b.js"];
    stubNetwork();
    const v1 = bootWorker("v1", v1Shell);
    await v1.fire("install").done();
    await v1.fire("activate").done();
    stubNetwork((url) => Promise.resolve(basic(`v2:${new URL(url).pathname}`)));
    const v2 = bootWorker("v2", v2Shell);
    await v2.fire("install").done();
    expect([...storage.all.keys()]).toEqual(["pap-shell-v1", "pap-shell-v2"]);

    stubNetwork(() => Promise.reject(new TypeError("offline")));
    const lazy = await (v1.fetchEvent("/assets/lazy-a.js").response as Promise<Response>);
    expect(await lazy.text()).toBe("net:/assets/lazy-a.js");
    const fallback = await (v1.fetchEvent("/", "navigate").response as Promise<Response>);
    expect(await fallback.text()).toBe("net:/index.html"); // v1's, not "v2:/index.html"

    // an asset only v2 has is not found through v1: it goes to the network
    const fetchMock = stubNetwork(() => Promise.resolve(basic("from network")));
    const other = await (v1.fetchEvent("/assets/lazy-b.js").response as Promise<Response>);
    expect(await other.text()).toBe("from network");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(storage.all.has("pap-shell-v1")).toBe(true);
    await v2.fire("activate").done();
    expect([...storage.all.keys()]).toEqual(["pap-shell-v2"]);
  });
});

describe("update.waits-for-message", () => {
  it("skips waiting only on an explicit skip-waiting message", async () => {
    stubNetwork();
    const worker = bootWorker("b1", SHELL);
    await worker.fire("install").done();
    expect(worker.scope.skipWaiting).not.toHaveBeenCalled();
    worker.fire("message", { data: { type: "other" } });
    worker.fire("message", { data: null });
    worker.fire("message", { data: "skip-waiting" });
    expect(worker.scope.skipWaiting).not.toHaveBeenCalled();
    worker.fire("message", { data: { type: "skip-waiting" } });
    expect(worker.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe("activate.prunes-other-builds", () => {
  it("deletes only the other pap-shell caches, then claims", async () => {
    stubNetwork();
    await storage.open("pap-shell-old");
    await storage.open("pap-shell-b1");
    await storage.open("other-cache");
    const worker = bootWorker("b1", SHELL);
    await worker.fire("activate").done();
    expect([...storage.all.keys()].sort()).toEqual(["other-cache", "pap-shell-b1"]);
    expect(worker.scope.clients.claim).toHaveBeenCalledTimes(1);
  });
});
