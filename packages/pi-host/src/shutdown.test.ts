import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { closeSession } from "./shutdown.ts";

function fakeTimers() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  // One macrotask turn: every promise hop queued so far (an abort settling, the next step arming its timer) runs.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    flush,
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    // A handle it does not hold (fired already, or cleared twice) is ignored: never `splice(-1, 1)` (M2-RT-07).
    clearTimer: (handle: unknown) => {
      const at = timers.indexOf(handle as never);
      if (at !== -1) timers.splice(at, 1);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
      await flush();
    },
  };
}

describe("closeSession", () => {
  it("stops the run, then tells the extensions, as the pi CLI does on quit", async () => {
    const order: string[] = [];
    const session = {
      abort: async () => void order.push("abort"),
      extensionRunner: {
        emit: async (event: { type: string; reason: string }) =>
          void order.push(`${event.type}:${event.reason}`),
      },
    } as unknown as AgentSession;
    await closeSession(session, 1500, fakeTimers());
    expect(order).toEqual(["abort", "session_shutdown:quit"]);
  });

  it("gives up on extensions that never finish when the grace runs out", async () => {
    const timers = fakeTimers();
    const session = {
      abort: async () => {},
      extensionRunner: { emit: () => new Promise(() => {}) },
    } as unknown as AgentSession;
    let done = false;
    const lines: string[] = [];
    const closing = closeSession(session, 1500, timers, (line) => void lines.push(line)).then(() => {
      done = true;
    });
    // The abort settles and the session_shutdown step arms its timer before any time passes.
    await timers.flush();
    await timers.advance(1499);
    expect(done).toBe(false);
    await timers.advance(1);
    await closing;
    expect(done).toBe(true);
    expect(lines).toEqual(["pi-host: session_shutdown did not finish within the shutdown grace\n"]);
  });

  it("still emits when the abort throws, and says so in one line", async () => {
    const emitted: string[] = [];
    const lines: string[] = [];
    const session = {
      abort: async () => {
        throw new Error("stuck\nsecond line");
      },
      extensionRunner: { emit: async (event: { type: string }) => void emitted.push(event.type) },
    } as unknown as AgentSession;
    await closeSession(session, 1500, fakeTimers(), (line) => void lines.push(line));
    expect(emitted).toEqual(["session_shutdown"]);
    expect(lines).toEqual(["pi-host: abort failed during shutdown: stuck second line\n"]);
  });
});
