import { afterEach, describe, expect, it, vi } from "vitest";
import type { PathScope } from "../../stores/reply-ports.ts";
import { imageTarget, IMAGE_HEAD_TIMEOUT_MS, MAX_IMAGE_BYTES, resolveImage } from "./image-target.ts";

const plain: PathScope = { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null };
const agent: PathScope = {
  base: "/agent/home",
  roots: ["/agent/home", "/agent/inbox"],
  filesRoot: "/agents/a1",
  agentId: "a1",
};

describe("imageTarget", () => {
  it("a relative path resolves under the base", () => {
    expect(imageTarget("shots/a.png", plain)).toEqual({ kind: "image", path: "/w/p/shots/a.png" });
  });

  it("an absolute path under a root is kept", () => {
    expect(imageTarget("/w/p/a.webp", plain)).toEqual({ kind: "image", path: "/w/p/a.webp" });
  });

  it("an agent path maps to its files root", () => {
    expect(imageTarget("/agent/home/a.png", agent)).toEqual({ kind: "image", path: "/agents/a1/home/a.png" });
  });

  it.each(["a.png", "a.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg"])("%s is an image", (name) => {
    expect(imageTarget(name, plain)?.kind).toBe("image");
  });

  it("a percent-encoded path is decoded once", () => {
    expect(imageTarget("caf%C3%A9/a%2Bb.png", plain)).toEqual({ kind: "image", path: "/w/p/café/a+b.png" });
  });

  it("another file type is a file", () => {
    expect(imageTarget("data.csv", plain)).toEqual({ kind: "file", path: "/w/p/data.csv" });
  });

  it.each([
    ["https://x/a.png"],
    ["http://x/a.png"],
    ["data:image/png;base64,AAAA"],
    ["javascript:alert(1)"],
    ["blob:https://x/1"],
    ["//x/a.png"],
    ["../a.png"],
    ["%2e%2e/a.png"],
    ["a/../../a.png"],
    ["a.png?x"],
    ["a.png#x"],
    ["a%3Fx.png"],
    ["%zz.png"],
    ["a.png:3"],
    ["/w/p/a.png:3"],
    ["/etc/a.png"],
    ["/w/pp/a.png"],
    ["w/p/"],
    [""],
  ])("refuses %j", (src) => {
    expect(imageTarget(src, plain)).toBeNull();
  });

  it("an agent path outside the agent roots is refused", () => {
    expect(imageTarget("/agent/other/a.png", agent)).toBeNull();
    expect(imageTarget("/w/p/a.png", agent)).toBeNull();
  });

  it("without a scope (a lane chat) nothing resolves", () => {
    expect(imageTarget("a.png", null)).toBeNull();
  });
});

const head = (status: number, headers: Record<string, string>) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status, headers })));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveImage", () => {
  it("a 200 image/png of 1 KiB is an image on the same-origin raw route", async () => {
    const fetcher = head(200, { "content-type": "image/png", "content-length": "1024" });
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveImage("a.png", plain)).toEqual({
      kind: "image",
      url: `/files/raw?path=${encodeURIComponent("/w/p/a.png")}`,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/files/raw?path=${encodeURIComponent("/w/p/a.png")}`,
      expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
    );
  });

  it("a length of exactly 10 MiB is an image, 11 MiB is text", async () => {
    vi.stubGlobal(
      "fetch",
      head(200, { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES) }),
    );
    expect((await resolveImage("a.png", plain)).kind).toBe("image");
    vi.stubGlobal(
      "fetch",
      head(200, { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) }),
    );
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
  });

  it("text/html is text", async () => {
    vi.stubGlobal("fetch", head(200, { "content-type": "text/html", "content-length": "10" }));
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
  });

  it("404 is text", async () => {
    vi.stubGlobal("fetch", head(404, { "content-type": "image/png", "content-length": "10" }));
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
  });

  it("a missing or malformed length is text", async () => {
    vi.stubGlobal("fetch", head(200, { "content-type": "image/png" }));
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
    vi.stubGlobal("fetch", head(200, { "content-type": "image/png", "content-length": "abc" }));
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
  });

  it("a network error is text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new Error("offline"))),
    );
    expect(await resolveImage("a.png", plain)).toEqual({ kind: "text" });
  });

  it("the HEAD carries an abort signal; aborting the caller's signal while it runs aborts it", async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const caller = new AbortController();
    const pending = resolveImage("a.png", plain, caller.signal);
    const sent = fetcher.mock.calls[0]?.[1]?.signal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent?.aborted).toBe(false);
    caller.abort();
    expect(sent?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "text" });
  });

  it("a signal that is already aborted sends an aborted request", async () => {
    const fetcher = head(200, {});
    vi.stubGlobal("fetch", fetcher);
    const caller = new AbortController();
    caller.abort();
    await resolveImage("a.png", plain, caller.signal);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("the deadline aborts the request, which answers text", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const pending = resolveImage("a.png", plain);
    deadline.abort();
    expect(await pending).toEqual({ kind: "text" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(IMAGE_HEAD_TIMEOUT_MS);
  });

  it("a file is a file without a request, a refused source is text without a request", async () => {
    const fetcher = head(200, {});
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveImage("data.csv", plain)).toEqual({ kind: "file", path: "/w/p/data.csv" });
    expect(await resolveImage("https://x/a.png", plain)).toEqual({ kind: "text" });
    expect(await resolveImage("a.png", null)).toEqual({ kind: "text" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
