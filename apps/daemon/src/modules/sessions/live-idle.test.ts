import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { IdleState } from "./idle-release.ts";
import { createLiveIdle } from "./live-idle.ts";

function setup(initial: IdleState = "quiet") {
  const clock = createFakeClock();
  const state = { value: initial };
  const idle = createLiveIdle({
    clock,
    idleMs: 30 * 60_000,
    logger: silentLogger,
    handle: { stop: () => Promise.resolve() } as unknown as WorkerHandle,
    cancelPanels: () => {},
    setStatus: () => {},
    state: () => state.value,
  });
  return { clock, state, idle };
}

describe("quietSince (M13R45)", () => {
  it("follows touch()", async () => {
    const { clock, idle } = setup();
    const start = clock.now();
    expect(idle.quietSince()).toBe(start);
    await clock.advance(60_000);
    idle.touch();
    expect(idle.quietSince()).toBe(start + 60_000);
  });

  it("is null while work is pending and back after", async () => {
    const { clock, state, idle } = setup();
    state.value = "busy";
    await clock.advance(1000);
    idle.touch();
    expect(idle.quietSince()).toBeNull();
    state.value = "quiet";
    expect(idle.quietSince()).toBe(clock.now());
  });

  it.each([
    ["a rename", "ok"],
    ["a set-model", "ok"],
    ["a compaction", "ok"],
    ["a failing command", "fail"],
  ])("moves for a command pap runs through active(): %s", async (_name, outcome) => {
    const { clock, idle } = setup();
    const start = clock.now();
    await clock.advance(10 * 60_000);
    const work = idle.active(async () => {
      await clock.advance(5_000);
      if (outcome === "fail") throw new Error("x");
    });
    await (outcome === "fail" ? work.catch(() => {}) : work);
    expect(idle.quietSince()).toBe(start + 10 * 60_000 + 5_000);
  });
});
