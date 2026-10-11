import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { WorkerExit } from "./exit.ts";
import { killLadder } from "./kill-ladder.ts";

function target() {
  const calls: string[] = [];
  let finish: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => {
    finish = resolve;
  });
  return {
    calls,
    exit: (exit: WorkerExit) => finish(exit),
    target: {
      shutdown: (graceMs: number) => {
        calls.push(`shutdown:${graceMs}`);
      },
      signal: (signal: string) => {
        calls.push(signal);
        return true;
      },
      exited,
    },
  };
}

describe("kill ladder", () => {
  it("stops at the shutdown rung when the worker exits in time", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(1000);
    t.exit({ code: 0, signal: null, cause: "clean" });
    expect((await done).cause).toBe("clean");
    expect(t.calls).toEqual(["shutdown:2000"]);
  });

  it("sends SIGTERM to the group after 2 s, then SIGKILL after 3 more", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(2000);
    expect(t.calls).toEqual(["shutdown:2000", "SIGTERM"]);
    await clock.advance(3000);
    expect(t.calls).toEqual(["shutdown:2000", "SIGTERM", "SIGKILL"]);
    t.exit({ code: null, signal: "SIGKILL", cause: "killed" });
    expect((await done).cause).toBe("killed");
  });

  it("does not send SIGKILL to a worker that exits after SIGTERM", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(2000);
    t.exit({ code: null, signal: "SIGTERM", cause: "signal" });
    expect((await done).cause).toBe("signal");
    await clock.advance(10_000);
    expect(t.calls).toEqual(["shutdown:2000", "SIGTERM"]);
  });

  it("climbs on when a rung throws", async () => {
    const clock = createFakeClock();
    const calls: string[] = [];
    const done = killLadder(
      {
        shutdown: () => {
          throw new Error("channel closed");
        },
        signal: (signal) => {
          calls.push(signal);
          throw new Error("EPERM");
        },
        exited: new Promise<WorkerExit>(() => {}),
      },
      clock,
    );
    await clock.advance(5000);
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
    await clock.advance(5000);
    expect(await done).toEqual({ code: null, signal: "SIGKILL", cause: "killed" });
  });

  it("still ends when the worker outlives SIGKILL, and leaves no timer behind", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(5000);
    await clock.advance(5000);
    expect((await done).cause).toBe("killed");
    expect(clock.pending()).toBe(0);
  });
});
