import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../clock.ts";
import {
  ancestorsOf,
  artifactCsp,
  hostSources,
  MAX_HOST_SOURCE_CHARS,
  serviceCsp,
  socketOriginOf,
} from "./csp.ts";
import { createOpenQueue, OpenBusy, PREVIEW_LIMITS } from "./limits.ts";

const APP = ["http://localhost:7777", "http://127.0.0.1:7777"];
const P = "http://localhost:7778";
const directive = (csp: string, name: string): string =>
  csp.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";

describe("serviceCsp", () => {
  it("a service without network reaches its own origin, data: and blob: only", () => {
    expect(serviceCsp({ appOrigins: APP, previewOrigin: P, hosts: [] })).toBe(
      [
        "sandbox allow-scripts allow-forms allow-downloads",
        `default-src ${P} data: blob: 'unsafe-inline' 'unsafe-eval'`,
        `connect-src ${P} ws://localhost:7778 data: blob:`,
        `frame-src ${P}`,
        `child-src ${P}`,
        `worker-src ${P}`,
        "object-src 'none'",
        `form-action ${P}`,
        `base-uri ${P}`,
        `frame-ancestors ${APP.join(" ")}`,
      ].join("; "),
    );
  });
  it("names no 'self', no wildcard scheme, no allow-popups and no allow-same-origin", () => {
    const csp = serviceCsp({ appOrigins: APP, previewOrigin: P, hosts: ["https://cdn.example"] });
    expect(csp).not.toContain("'self'");
    expect(csp).not.toMatch(/(^|\s)(https?|wss?|\*):(\s|;|$)/);
    expect(csp).not.toContain("allow-popups");
    expect(csp).not.toContain("allow-same-origin");
    expect(directive(csp, "frame-src")).not.toMatch(/data:|blob:/);
    expect(directive(csp, "worker-src")).not.toMatch(/data:|blob:/);
  });
  it("a networked service also reaches its hosts, sockets included", () => {
    const hosts = ["https://cdn.example", "wss://cdn.example"];
    const csp = serviceCsp({ appOrigins: APP, previewOrigin: P, hosts });
    expect(directive(csp, "connect-src")).toBe(
      `connect-src ${P} ws://localhost:7778 https://cdn.example wss://cdn.example data: blob:`,
    );
    expect(directive(csp, "default-src")).toContain("https://cdn.example");
    expect(directive(csp, "frame-src")).toBe(`frame-src ${P} https://cdn.example wss://cdn.example`);
    expect(directive(csp, "form-action")).toContain("https://cdn.example");
    expect(directive(csp, "worker-src")).toBe(`worker-src ${P}`);
    expect(directive(csp, "base-uri")).toBe(`base-uri ${P}`);
  });
  it("a plain-HTTP preview origin has a ws: socket form, an https one wss:", () => {
    expect(socketOriginOf("http://192.0.2.1:7778")).toBe("ws://192.0.2.1:7778");
    expect(socketOriginOf("https://p.example")).toBe("wss://p.example");
    expect(directive(serviceCsp({ appOrigins: APP, previewOrigin: P, hosts: [] }), "connect-src")).toContain(
      " ws://localhost:7778 ",
    );
  });
  it("leaves an IPv6 app origin out of frame-ancestors, and falls back to 'none'", () => {
    expect(ancestorsOf(["http://[::1]:7777", "http://localhost:7777"])).toBe("http://localhost:7777");
    expect(ancestorsOf(["http://[::1]:7777"])).toBe("'none'");
    expect(ancestorsOf([])).toBe("'none'");
  });
});

describe("artifactCsp", () => {
  it("an artifact keeps its no-network policy", () => {
    expect(artifactCsp(APP)).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
        `form-action 'none'; base-uri 'none'; frame-ancestors ${APP.join(" ")}`,
    );
  });
});

// Equivalent mutant, not killed on purpose: dropping the IPv6 check of `hostSources` changes nothing, because the SOURCE
// shape refuses a colon inside the host anyway.
const EXACT_SOURCES = 348;
const LAST_SOURCE = "wss://host-086.example";

describe("hostSources", () => {
  it("leaves out every IP entry the proxy always refuses, and keeps an exact private one", () => {
    const refused = [
      "0.0.0.0:7777",
      "169.254.169.254",
      "100.100.1.1:8080",
      "10.213.0.1:7843",
      "198.51.100.4",
      "224.0.0.1:80",
    ];
    for (const entry of refused) expect(hostSources([entry], own), entry).toEqual([]);
    expect(hostSources([...refused, "172.16.0.9:8080"], own)).toHaveLength(4);
  });
  const own = ["localhost", "pap.example", "10.9.9.9"];
  it("maps a bare host and a wildcard to the four schemes, a port to that port", () => {
    expect(hostSources(["cdn.example"], own)).toEqual([
      "http://cdn.example",
      "https://cdn.example",
      "ws://cdn.example",
      "wss://cdn.example",
    ]);
    expect(hostSources(["*.cdn.example"], own)).toEqual([
      "http://*.cdn.example",
      "https://*.cdn.example",
      "ws://*.cdn.example",
      "wss://*.cdn.example",
    ]);
    expect(hostSources(["api.example:8443"], own)).toEqual([
      "http://api.example:8443",
      "https://api.example:8443",
      "ws://api.example:8443",
      "wss://api.example:8443",
    ]);
    expect(hostSources(["10.1.2.3"], own)).toEqual([
      "http://10.1.2.3",
      "https://10.1.2.3",
      "ws://10.1.2.3",
      "wss://10.1.2.3",
    ]);
  });
  it("leaves out IPv6, loopback, pap's own hosts on any port, and what the proxy's parser refuses", () => {
    const entries = [
      "[2001:db8::1]:443",
      "2001:db8::1",
      "localhost",
      "foo.localhost",
      "127.0.0.1",
      "127.3.4.5:80",
      "pap.example",
      "pap.example:9999",
      "10.9.9.9:81",
      "evil.test;script-src *",
      "not a host",
      "*",
      "",
    ];
    expect(hostSources(entries, own)).toEqual([]);
    expect(hostSources([...entries, "ok.example"], own)).toHaveLength(4);
  });
  it("a wildcard that covers one of pap's hosts is left out", () => {
    expect(hostSources(["*.example"], own)).toEqual([]);
    expect(hostSources(["*.other.example"], own)).toHaveLength(4);
  });
  it("matches pap's own hosts without case or brackets", () => {
    expect(hostSources(["pap.example"], ["PAP.example"])).toEqual([]);
    expect(hostSources(["10.1.2.3"], ["[10.1.2.3]"])).toEqual([]);
    expect(hostSources(["10.1.2.3"], ["10.1.2.4"])).toHaveLength(4);
  });
  it("stops at 8 KiB of sources: the entries past it are left out, never cut in half", () => {
    const entries = Array.from({ length: 400 }, (_, i) => `host-${String(i).padStart(3, "0")}.example`);
    const sources = hostSources(entries, own);
    const chars = sources.reduce((sum, source) => sum + source.length + 1, 0);
    expect(chars).toBeLessThanOrEqual(MAX_HOST_SOURCE_CHARS);
    expect(sources).toHaveLength(EXACT_SOURCES);
    expect(sources.at(-1)).toBe(LAST_SOURCE);
    expect(sources.length % 4).toBe(0);
    for (const source of sources) expect(source).toMatch(/^(?:https?|wss?):\/\/host-\d{3}\.example$/);
    expect(sources).not.toContain("https://host-399.example");
  });
  it("lists a source once", () => {
    expect(hostSources(["cdn.example", "cdn.example"], own)).toHaveLength(4);
    expect(hostSources(["cdn.example:443", "cdn.example:443"], own)).toHaveLength(4);
  });
});

describe("createOpenQueue", () => {
  const setup = (
    inFlight: number = PREVIEW_LIMITS.opensPerBox,
    waiting: number = PREVIEW_LIMITS.openWaitersPerBox,
    waitMs: number = PREVIEW_LIMITS.openWaitMs,
  ) => {
    const clock = createFakeClock();
    const queue = createOpenQueue({ clock, inFlight, waiting, waitMs });
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const open = (n: number) => () =>
      new Promise<number>((resolve) => {
        started.push(n);
        gates.push(() => resolve(n));
      });
    return { clock, queue, started, gates, open };
  };

  it("12 parallel GETs through a fake two-slot open all succeed in order; the 33rd waiting is busy", async () => {
    const { clock, queue, started, gates, open } = setup();
    const done: Array<Promise<number>> = [];
    for (let n = 0; n < 34; n++) done.push(queue.run("box", open(n)));
    expect(queue.size("box")).toEqual({ inFlight: 2, waiting: 32 });
    await expect(queue.run("box", open(34))).rejects.toBeInstanceOf(OpenBusy);
    expect(queue.size("box")).toEqual({ inFlight: 2, waiting: 32 });
    expect(started).toEqual([0, 1]);
    for (let step = 0; step < 12; step++) {
      gates.shift()?.();
      await clock.advance(0);
    }
    expect(started.slice(0, 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    while (gates.length > 0) {
      gates.shift()?.();
      await clock.advance(0);
    }
    expect(await Promise.all(done)).toEqual(Array.from({ length: 34 }, (_, n) => n));
    expect(queue.size("box")).toEqual({ inFlight: 0, waiting: 0 });
    expect(clock.pending()).toBe(0);
  });

  it("never has more than the allowed opens in flight", async () => {
    const { clock, queue, started, gates, open } = setup();
    const done = [0, 1, 2, 3, 4].map((n) => queue.run("box", open(n)));
    await clock.advance(0);
    expect(started).toEqual([0, 1]);
    gates.shift()?.();
    await clock.advance(0);
    expect(started).toEqual([0, 1, 2]);
    expect(queue.size("box").inFlight).toBe(2);
    while (gates.length > 0) {
      gates.shift()?.();
      await clock.advance(0);
    }
    await Promise.all(done);
  });

  it("a wait past 15 s is busy and frees its place in the queue; a failed open lets the next one go", async () => {
    const { clock, queue, started, gates, open } = setup(1, 2, 15_000);
    const first = queue.run("box", open(0));
    const second = queue.run("box", () => Promise.reject(new Error("guest said no")));
    const secondBusy = expect(second).rejects.toBeInstanceOf(OpenBusy);
    const third = queue.run("box", open(2));
    const late = expect(third).rejects.toBeInstanceOf(OpenBusy);
    await clock.advance(14_999);
    expect(queue.size("box").waiting).toBe(2);
    await clock.advance(1);
    await late;
    await secondBusy;
    expect(queue.size("box")).toEqual({ inFlight: 1, waiting: 0 });
    expect(started).toEqual([0]);
    const fourth = queue.run("box", open(3));
    gates.shift()?.();
    await first;
    await clock.advance(0);
    gates.shift()?.();
    expect(await fourth).toBe(3);
    // a failing open frees its place for the next waiter
    const a = queue.run("box", () => Promise.reject(new Error("boom")));
    const b = queue.run("box", open(5));
    await expect(a).rejects.toThrow("boom");
    await clock.advance(0);
    gates.shift()?.();
    expect(await b).toBe(5);
    expect(clock.pending()).toBe(0);
  });

  it("an aborted wait leaves the queue; boxes do not share places", async () => {
    const { clock, queue, gates, open } = setup(1, 2);
    const hold = queue.run("a", open(0));
    const controller = new AbortController();
    const waiting = queue.run("a", open(1), controller.signal);
    expect(queue.size("a").waiting).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(OpenBusy);
    expect(queue.size("a").waiting).toBe(0);
    expect(clock.pending()).toBe(0);
    // another box runs at once while "a" is full
    const other = queue.run("b", open(9));
    expect(queue.size("b")).toEqual({ inFlight: 1, waiting: 0 });
    await expect(queue.run("a", open(2), AbortSignal.abort())).rejects.toBeInstanceOf(OpenBusy);
    for (const gate of gates.splice(0)) gate();
    await Promise.all([hold, other]);
    expect(queue.size("a")).toEqual({ inFlight: 0, waiting: 0 });
    expect(queue.size("b")).toEqual({ inFlight: 0, waiting: 0 });
  });

  it("an open that throws at once is rejected and frees its place, direct and waiting", async () => {
    const { clock, queue, gates, open } = setup(1, 4);
    const boom = (): Promise<number> => {
      throw new Error("sync boom");
    };
    await expect(queue.run("box", boom)).rejects.toThrow("sync boom");
    await expect(queue.run("box", boom)).rejects.toThrow("sync boom");
    expect(queue.size("box")).toEqual({ inFlight: 0, waiting: 0 });
    const hold = queue.run("box", open(0));
    const thrown = queue.run("box", boom);
    const thrownRejects = expect(thrown).rejects.toThrow("sync boom");
    const after = queue.run("box", open(2));
    gates.shift()?.();
    await hold;
    await thrownRejects;
    await clock.advance(0);
    gates.shift()?.();
    expect(await after).toBe(2);
    expect(queue.size("box")).toEqual({ inFlight: 0, waiting: 0 });
  });

  it("leaves no timer after the waiters have started", async () => {
    const { clock, queue, gates, open } = setup(1, 4);
    const done = [0, 1, 2].map((n) => queue.run("box", open(n)));
    expect(clock.pending()).toBe(2);
    while (gates.length > 0) {
      gates.shift()?.();
      await clock.advance(0);
    }
    await Promise.all(done);
    expect(clock.pending()).toBe(0);
  });
});
