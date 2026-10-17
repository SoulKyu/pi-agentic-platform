// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, type Timers } from "./connection.ts";
import { getRuntime, stopRuntime } from "./index.ts";
import type { RpcClient } from "./rpc.ts";
import { connectionBed as setup, flush } from "./testing.ts";
import { createSubscriptions } from "./subscriptions.ts";

afterEach(() => {
  stopRuntime();
  vi.useRealTimers();
  localStorage.clear();
});

describe("connection supervisor: resume after a background", () => {
  it("resume.long-hidden-reconnects-now: hidden 31 s replaces the socket without waiting for the dead timer", () => {
    const { connection, latest, sockets, hello } = setup();
    connection.start();
    hello();
    const first = latest();
    expect(connection.state).toBe("open");
    connection.resume(31_000);
    expect(sockets).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(connection.state).toBe("connecting");
    expect(latest()).not.toBe(first);
  });

  it("resume.long-hidden-reconnects-now: 30 s exactly counts as long, and a connecting socket is replaced too", () => {
    const { connection, sockets } = setup();
    connection.start();
    connection.resume(30_000);
    expect(sockets).toHaveLength(2);
  });

  it("resume.short-hidden-nudges-only: under 30 s keeps the open socket", () => {
    const { connection, latest, sockets, hello } = setup();
    connection.start();
    hello();
    const first = latest();
    connection.resume(29_999);
    expect(sockets).toHaveLength(1);
    expect(first.closed).toBe(false);
    expect(connection.state).toBe("open");
  });

  it("resume.short-hidden-nudges-only: a short hide while waiting probes and reconnects like a nudge", async () => {
    const { connection, latest, sockets } = setup();
    connection.start();
    latest().close();
    await flush();
    expect(connection.state).toBe("waiting");
    connection.resume(1_000);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("resume.wiring: the page measures how long the tab was hidden and passes it to the supervisor", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const runtime = getRuntime();
    const resume = vi.spyOn(runtime.connection, "resume").mockImplementation(() => {});
    const visibility = (value: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visibility("hidden");
    expect(resume).not.toHaveBeenCalled();
    vi.setSystemTime(1_031_000);
    visibility("visible");
    expect(resume).toHaveBeenCalledExactlyOnceWith(31_000);
    visibility("visible");
    expect(resume).toHaveBeenLastCalledWith(0);
  });
});

describe("connection supervisor: cursor resume", () => {
  function subscribed() {
    const bed = setup();
    const calls: Array<[string, unknown]> = [];
    let subs = 0;
    const rpc = {
      call: (method: string, params: unknown) => {
        calls.push([method, params]);
        return Promise.resolve(method.startsWith("subscribe.") ? { sub: `s${++subs}` } : { ok: true });
      },
    } as unknown as RpcClient;
    let expire: (() => void) | null = null;
    const timers: Timers = {
      set: (fn) => {
        expire = fn;
        return 1;
      },
      clear: () => {
        expire = null;
      },
    };
    const subscriptions = createSubscriptions(bed.connection, rpc, timers);
    const events: unknown[] = [];
    const frame = (sub: string, seq: number, event: unknown) =>
      bed.latest().receive({ sub, epoch: "e1", seq, event });
    return { ...bed, calls, subscriptions, events, frame, expire: () => expire?.() };
  }

  it("cursor.resume-no-gap-no-dup: a dropped socket resumes after the last seen seq", async () => {
    const bed = subscribed();
    bed.connection.start();
    bed.hello();
    bed.subscriptions.subscribe("session", "k", (event) => bed.events.push(event));
    await flush();
    bed.frame("s1", 1, "a");
    bed.frame("s1", 2, "b");
    bed.latest().close();
    await flush();
    bed.advance(backoffDelay(0, 0.5));
    bed.hello();
    await flush();
    expect(bed.calls.at(-1)).toEqual([
      "subscribe.session",
      { sessionId: "k", after: { epoch: "e1", seq: 2 } },
    ]);
    // the server replays what came after seq 2; a frame of the dead sub is ignored
    bed.frame("s1", 3, "late-from-old-sub");
    bed.frame("s2", 3, "c");
    bed.frame("s2", 4, "d");
    expect(bed.events).toEqual(["a", "b", "c", "d"]);
  });

  it("cursor.expired-asks-snapshot: after the 5 minute cursor life the resubscribe has no cursor", async () => {
    const bed = subscribed();
    bed.connection.start();
    bed.hello();
    const off = bed.subscriptions.subscribe("session", "k", () => {});
    await flush();
    bed.frame("s1", 5, "a");
    off();
    bed.expire();
    bed.subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(bed.calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k" }]);
  });
});
