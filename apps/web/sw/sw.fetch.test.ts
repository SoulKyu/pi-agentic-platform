import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basic, bootWorker, freshCaches, SHELL, stubNetwork, type FakeCaches } from "./harness.ts";

let storage: FakeCaches;
beforeEach(() => {
  storage = freshCaches();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function installed(buildId = "b1") {
  stubNetwork();
  const worker = bootWorker(buildId, SHELL);
  await worker.fire("install").done();
  return worker;
}

describe("no-authenticated-response-cached", () => {
  it.each(["/auth/session", "/files/x", "/api/x", "/healthz", "/upload", "/ws", "/metrics", "/sw.js"])(
    "%s is network only: no respondWith, nothing cached",
    async (path) => {
      const worker = await installed();
      const cache = storage.all.get("pap-shell-b1");
      const before = [...(cache?.store.keys() ?? [])];
      expect(before).toHaveLength(SHELL.length); // a populated cache: "unchanged" below is not vacuous
      for (const mode of ["cors", "navigate"]) {
        const fired = worker.fetchEvent(path, mode);
        expect(fired.respondWith).not.toHaveBeenCalled();
      }
      expect(cache?.puts).toEqual([]);
      expect([...(cache?.store.keys() ?? [])]).toEqual(before);
      expect([...storage.all.keys()]).toEqual(["pap-shell-b1"]);
    },
  );

  it("a POST and a cross-origin request are not intercepted either", () => {
    const worker = bootWorker("b1", SHELL);
    expect(worker.fetchEvent("/assets/a.js", "cors", "POST").respondWith).not.toHaveBeenCalled();
    const foreign = worker.fire("fetch", {
      request: { method: "GET", mode: "cors", url: "https://evil.example/assets/a.js" },
    });
    expect(foreign.respondWith).not.toHaveBeenCalled();
  });
});

describe("shell.cache-first-and-put-assets-only", () => {
  it("a miss on an asset fetches and puts it", async () => {
    const worker = await installed();
    const cache = storage.all.get("pap-shell-b1");
    const fetchMock = stubNetwork();
    const res = await worker.fetchEvent("/assets/x.js").response;
    expect(await (res as Response).text()).toBe("net:/assets/x.js");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache?.puts).toEqual(["/assets/x.js"]);
  });

  it("a miss on a non-asset shell file fetches and does NOT put", async () => {
    const worker = await installed();
    const cache = storage.all.get("pap-shell-b1");
    cache?.store.delete("/manifest.webmanifest");
    const fetchMock = stubNetwork();
    await worker.fetchEvent("/manifest.webmanifest").response;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache?.puts).toEqual([]);
  });

  it("does not put a response that is not cacheable", async () => {
    const worker = await installed();
    const cache = storage.all.get("pap-shell-b1");
    stubNetwork(() => Promise.resolve(basic("secret", { headers: { "cache-control": "private" } })));
    await worker.fetchEvent("/assets/y.js").response;
    stubNetwork(() => Promise.resolve(basic("gone", { status: 404 })));
    await worker.fetchEvent("/assets/z.js").response;
    expect(cache?.puts).toEqual([]);
  });

  it("a hit is served without fetch", async () => {
    const worker = await installed();
    const fetchMock = stubNetwork();
    const res = await worker.fetchEvent("/assets/lazy-a.js").response;
    expect(await (res as Response).text()).toBe("net:/assets/lazy-a.js"); // the precached body
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("navigation.network-first-with-deadline", () => {
  const nav = (worker: Awaited<ReturnType<typeof installed>>) =>
    worker.fetchEvent("/n/abc", "navigate").response as Promise<Response>;

  it("returns the network answer and writes nothing", async () => {
    const worker = await installed();
    const cache = storage.all.get("pap-shell-b1");
    stubNetwork(() => Promise.resolve(basic("user data")));
    expect(await (await nav(worker)).text()).toBe("user data");
    expect(cache?.puts).toEqual([]);
  });

  it("falls back to the cached index.html when the network fails", async () => {
    const worker = await installed();
    stubNetwork(() => Promise.reject(new TypeError("offline")));
    expect(await (await nav(worker)).text()).toBe("net:/index.html");
  });

  it("falls back after 8 s when the fetch never answers", async () => {
    const worker = await installed();
    vi.useFakeTimers();
    stubNetwork(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const settled = vi.fn();
    const pending = nav(worker).then(async (res) => settled(await res.text()));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(settled).toHaveBeenCalledWith("net:/index.html");
  });

  it("falls back when a proxy answers 5xx", async () => {
    const worker = await installed();
    stubNetwork(() => Promise.resolve(basic("bad gateway", { status: 502 })));
    expect(await (await nav(worker)).text()).toBe("net:/index.html");
  });

  it("gives Response.error() when there is no cached shell", async () => {
    stubNetwork(() => Promise.reject(new TypeError("offline")));
    const worker = bootWorker("b1", SHELL);
    const res = await (worker.fetchEvent("/", "navigate").response as Promise<Response>);
    expect(res.type).toBe("error");
  });
});
