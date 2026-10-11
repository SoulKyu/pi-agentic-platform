import { PROTOCOL_VERSION } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, postJson, probeServer } from "./http.ts";

function respond(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body === "" ? null : body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeServer", () => {
  it.each([
    [426, "outdated"],
    [401, "signed-out"],
    [200, "ok"],
    [500, "offline"],
    [502, "offline"],
  ])("maps status %i to %s", async (status, expected) => {
    const fetchMock = vi.fn(async () => respond(status));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeServer()).toBe(expected);
    expect(fetchMock).toHaveBeenCalledWith(
      `/ws?proto=${PROTOCOL_VERSION}`,
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("reports offline when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await probeServer()).toBe("offline");
  });

  it("gives up on a request that never answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const result = probeServer();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe("offline");
  });
});

describe("getJson and postJson", () => {
  it("parse the body and read retry-after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(429, '{"error":{"code":"rate_limited"}}', { "retry-after": "12" })),
    );
    expect(await getJson("/api/x")).toEqual({
      status: 429,
      body: { error: { code: "rate_limited" } },
      retryAfterSeconds: 12,
    });
  });

  it("read retry-after as seconds or as an HTTP date, and ignore anything else", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(respond(429, "{}", { "retry-after": "7" }))
        .mockResolvedValueOnce(respond(503, "{}", { "retry-after": "Sat, 10 Oct 2026 12:00:30 GMT" }))
        .mockResolvedValueOnce(respond(503, "{}", { "retry-after": "Sat, 10 Oct 2026 11:00:00 GMT" }))
        .mockResolvedValueOnce(respond(503, "{}", { "retry-after": "soon" })),
    );
    const seconds = async () => (await getJson("/api/x")).retryAfterSeconds;
    expect([await seconds(), await seconds(), await seconds(), await seconds()]).toEqual([7, 30, 0, null]);
  });

  it("give a null body for an empty or unreadable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(respond(204)).mockResolvedValueOnce(respond(502, "<html>")),
    );
    expect(await getJson("/api/x")).toEqual({ status: 204, body: null, retryAfterSeconds: null });
    expect(await getJson("/api/x")).toEqual({ status: 502, body: null, retryAfterSeconds: null });
  });

  it("post a JSON body with the session cookie", async () => {
    const fetchMock = vi.fn(async () => respond(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);
    await postJson("/api/login", { username: "me" });
    await postJson("/api/logout", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: '{"username":"me"}',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/logout", expect.objectContaining({ body: "{}" }));
  });
});
