import { describe, expect, it, vi } from "vitest";
import { type FetchLike, FetchRefused, fetchLimited } from "./fetch.ts";

const START = "https://github.com/SoulKyu/pi-agentic-platform/releases/latest/download/pap-feed-stable.json";
const CDN = "https://objects.githubusercontent.com/github-production-release-asset/1/a?sig=abc";
const UA = "pap/1.2.3";
const OPTIONS = { maxBytes: 100, timeoutMs: 1000, userAgent: UA };

type Init = Parameters<FetchLike>[1];
interface Call {
  url: string;
  init: Init;
}

/** A stub `fetch`: each answer is used once, in order; the calls are recorded. */
function stub(...answers: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error("no more answers"));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fetch, calls };
}

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });
const ok = (body: string | Uint8Array = "ok"): Response => new Response(body, { status: 200 });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FetchRefused);
    return (error as FetchRefused).code;
  }
  return "no error";
}

describe("fetchLimited", () => {
  it("returns the body of a plain 200", async () => {
    const { fetch } = stub(ok("hello"));
    const bytes = await fetchLimited(START, { ...OPTIONS, fetch });
    expect(Buffer.from(bytes).toString()).toBe("hello");
  });

  it("follows a redirect to the asset CDN, whatever its path", async () => {
    const { fetch, calls } = stub(redirect(CDN), ok("asset"));
    const bytes = await fetchLimited(START, { ...OPTIONS, fetch });
    expect(Buffer.from(bytes).toString()).toBe("asset");
    expect(calls.map((c) => c.url)).toEqual([START, CDN]);
  });

  it("follows a relative redirect that stays under the project's releases", async () => {
    const { fetch, calls } = stub(redirect("/SoulKyu/pi-agentic-platform/releases/download/v1/a"), ok());
    await fetchLimited(START, { ...OPTIONS, fetch });
    expect(calls[1]?.url).toBe("https://github.com/SoulKyu/pi-agentic-platform/releases/download/v1/a");
  });

  it("refuses a redirect to a foreign host", async () => {
    const { fetch } = stub(redirect("https://evil.example/x"));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("host");
  });

  it("refuses a redirect from the project to another repository's release (M6b-RT-15)", async () => {
    const { fetch } = stub(redirect("https://github.com/other-owner/x/releases/download/v1/a"), ok());
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("host");
  });

  it("refuses a redirect to a sibling repository whose name starts with the project's", async () => {
    const { fetch } = stub(
      redirect("https://github.com/SoulKyu/pi-agentic-platform-evil/releases/download/v1/a"),
      ok(),
    );
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("host");
  });

  it("refuses a redirect to http:", async () => {
    const { fetch } = stub(redirect("http://objects.githubusercontent.com/a"));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("scheme");
  });

  it("refuses a redirect to a port", async () => {
    const { fetch } = stub(redirect("https://objects.githubusercontent.com:8443/a"));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("scheme");
  });

  it("refuses a redirect that carries user info", async () => {
    const { fetch } = stub(redirect("https://user:pw@objects.githubusercontent.com/a"));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("scheme");
  });

  it("refuses a redirect loop after 3 redirects", async () => {
    const { fetch, calls } = stub(redirect(CDN), redirect(CDN), redirect(CDN), redirect(CDN), ok());
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("redirects");
    expect(calls).toHaveLength(4);
  });

  it("accepts exactly 3 redirects", async () => {
    const { fetch } = stub(redirect(CDN), redirect(CDN), redirect(CDN), ok("end"));
    expect(Buffer.from(await fetchLimited(START, { ...OPTIONS, fetch })).toString()).toBe("end");
  });

  it("refuses a redirect without a location", async () => {
    const { fetch } = stub(new Response(null, { status: 302 }));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("redirects");
  });

  it("refuses a redirect whose location is not a URL", async () => {
    const { fetch } = stub(redirect("https://[bad"));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("redirects");
  });

  it("refuses a body of 500 bytes with a cap of 100", async () => {
    const { fetch } = stub(ok("x".repeat(500)));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("too_large");
  });

  it("accepts a body of exactly the cap", async () => {
    const { fetch } = stub(ok("x".repeat(100)));
    expect((await fetchLimited(START, { ...OPTIONS, fetch })).byteLength).toBe(100);
  });

  it("enforces the cap on 10 small chunks whatever Content-Length says", async () => {
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(20).fill(65));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const { fetch } = stub(new Response(body, { status: 200, headers: { "content-length": "5" } }));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("too_large");
  });

  it("refuses a 404 and a 500", async () => {
    expect(
      await code(
        fetchLimited(START, { ...OPTIONS, fetch: stub(new Response("nope", { status: 404 })).fetch }),
      ),
    ).toBe("status");
    expect(
      await code(
        fetchLimited(START, { ...OPTIONS, fetch: stub(new Response("boom", { status: 500 })).fetch }),
      ),
    ).toBe("status");
  });

  it("refuses an http: start without calling fetch", async () => {
    const { fetch, calls } = stub(ok());
    expect(await code(fetchLimited(START.replace("https:", "http:"), { ...OPTIONS, fetch }))).toBe("scheme");
    expect(calls).toHaveLength(0);
  });

  it("refuses a start with a port or user info without calling fetch", async () => {
    const { fetch, calls } = stub(ok());
    expect(
      await code(fetchLimited(START.replace("github.com", "github.com:8443"), { ...OPTIONS, fetch })),
    ).toBe("scheme");
    expect(
      await code(fetchLimited(START.replace("github.com", "user:pw@github.com"), { ...OPTIONS, fetch })),
    ).toBe("scheme");
    expect(calls).toHaveLength(0);
  });

  it("refuses a start that is not a URL", async () => {
    expect(await code(fetchLimited("not a url", { ...OPTIONS, fetch: stub(ok()).fetch }))).toBe("scheme");
  });

  it("refuses a foreign host and a CDN start, and another repository's start, without calling fetch", async () => {
    const { fetch, calls } = stub(ok());
    expect(
      await code(
        fetchLimited("https://evil.example/SoulKyu/pi-agentic-platform/releases/x", { ...OPTIONS, fetch }),
      ),
    ).toBe("host");
    expect(await code(fetchLimited(CDN, { ...OPTIONS, fetch }))).toBe("host");
    expect(
      await code(
        fetchLimited("https://github.com/other-owner/x/releases/download/v1/a", { ...OPTIONS, fetch }),
      ),
    ).toBe("host");
    expect(calls).toHaveLength(0);
  });

  it("gives timeout when the deadline fires, even with a caller signal that never aborts", async () => {
    const deadline = new AbortController();
    deadline.abort();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const fetch: FetchLike = (_url, init) =>
        init.signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(ok());
      const caller = new AbortController();
      expect(
        await code(fetchLimited(START, { ...OPTIONS, timeoutMs: 5, fetch, signal: caller.signal })),
      ).toBe("timeout");
      expect(await code(fetchLimited(START, { ...OPTIONS, timeoutMs: 5, fetch }))).toBe("timeout");
      expect(spy).toHaveBeenCalledWith(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives timeout when the deadline fires while the body is read", async () => {
    const deadline = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(streamController) {
          deadline.abort();
          streamController.error(new Error("socket closed"));
        },
      });
      const { fetch } = stub(new Response(body, { status: 200 }));
      expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("timeout");
    } finally {
      spy.mockRestore();
    }
  });

  it("labels a caller's own abort as network, not timeout", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetch: FetchLike = (_url, init) =>
      init.signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(ok());
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch, signal: caller.signal }))).toBe("network");
  });

  it("passes a signal to fetch that follows the caller's abort", async () => {
    const caller = new AbortController();
    const { fetch, calls } = stub(ok());
    await fetchLimited(START, { ...OPTIONS, fetch, signal: caller.signal });
    expect(calls[0]?.init.signal.aborted).toBe(false);
    caller.abort();
    expect(calls[0]?.init.signal.aborted).toBe(true);
  });

  it("stops reading a 10 000 chunk body after the cap and cancels the source once", async () => {
    let pulls = 0;
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(20));
        if (pulls === 10_000) controller.close();
      },
      cancel() {
        cancels++;
      },
    });
    const { fetch } = stub(new Response(body, { status: 200 }));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("too_large");
    expect(pulls).toBeLessThanOrEqual(7);
    expect(cancels).toBe(1);
  });

  it("keeps the status code when cancelling the body of a 404 rejects with a raw error", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("raw stored error /secret/path");
      },
    });
    const { fetch } = stub(new Response(body, { status: 404 }));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("status");
  });

  it("follows a redirect whose body cancel rejects, and refuses with a code when it cannot", async () => {
    const failing = (location: string): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("raw stored error");
          },
        }),
        { status: 302, headers: { location } },
      );
    const first = stub(failing(CDN), ok("fine"));
    expect(Buffer.from(await fetchLimited(START, { ...OPTIONS, fetch: first.fetch })).toString()).toBe(
      "fine",
    );
    const second = stub(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("raw");
          },
        }),
        { status: 302 },
      ),
    );
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch: second.fetch }))).toBe("redirects");
  });

  it("maps a fetch that rejects with null or a non-Error to network", async () => {
    const fetch: FetchLike = () => Promise.reject(null);
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("network");
  });

  it("gives network for a fetch that throws, and never copies its message", async () => {
    const { fetch } = stub(new Error("getaddrinfo ENOTFOUND secret-captive-portal.example"));
    try {
      await fetchLimited(START, { ...OPTIONS, fetch });
      expect.unreachable();
    } catch (error) {
      expect((error as FetchRefused).code).toBe("network");
      expect((error as FetchRefused).message).toBe("download refused (network)");
      expect((error as FetchRefused).message).not.toContain("secret-captive-portal");
    }
  });

  it("gives network for a body that fails mid-read", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    const { fetch } = stub(new Response(body, { status: 200 }));
    expect(await code(fetchLimited(START, { ...OPTIONS, fetch }))).toBe("network");
  });

  it("sends manual redirects, the user agent and no cookie or authorization on every hop", async () => {
    const { fetch, calls } = stub(redirect(CDN), ok());
    await fetchLimited(START, { ...OPTIONS, fetch });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.redirect).toBe("manual");
      expect(call.init.headers).toEqual({ "user-agent": UA });
      expect(Object.keys(call.init.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
      expect(Object.keys(call.init.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
  });
});
