import type { GetStateData } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createRunTracker } from "./run-tracker.ts";

const idle: GetStateData = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  sessionFile: "/f",
  sessionId: "s",
};
const busy: GetStateData = { ...idle, pendingMessageCount: 1 };

function setup(states: Array<GetStateData | Error>) {
  const clock = createFakeClock();
  const log: string[] = [];
  let probes = 0;
  const tracker = createRunTracker({
    clock,
    probe: async () => {
      const next = states[Math.min(probes++, states.length - 1)] ?? idle;
      if (next instanceof Error) throw next;
      return next;
    },
    onRunStart: () => log.push("start"),
    onRunEnd: ({ aborted }) => log.push(`end:${aborted}`),
  });
  return { clock, log, tracker, probes: () => probes };
}

describe("run tracker", () => {
  it("ends a run only after agent_settled is confirmed idle by get_state", async () => {
    const { clock, log, tracker } = setup([idle]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_end" });
    await clock.advance(0);
    expect(log).toEqual(["start"]);
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(0);
    expect(log).toEqual(["start", "end:false"]);
  });

  it("probes three times 100 ms apart and stays running if Pi is never idle", async () => {
    const { clock, log, tracker, probes } = setup([busy]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(300);
    expect(probes()).toBe(3);
    expect(tracker.running).toBe(true);
    expect(log).toEqual(["start"]);
  });

  it("counts a probe that fails like one that finds Pi busy", async () => {
    const { clock, log, tracker, probes } = setup([new Error("no answer"), idle]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(100);
    expect(probes()).toBe(2);
    expect(log).toEqual(["start", "end:false"]);
  });

  it("ends on a later probe, and a new input cancels a pending probe", async () => {
    const ends = setup([busy, idle]);
    ends.tracker.onEvent({ type: "agent_start" });
    ends.tracker.onEvent({ type: "agent_settled", aborted: true });
    await ends.clock.advance(100);
    expect(ends.log).toEqual(["start", "end:true"]);
    const cancelled = setup([busy, idle]);
    cancelled.tracker.onEvent({ type: "agent_start" });
    cancelled.tracker.onEvent({ type: "agent_settled", aborted: false });
    await cancelled.clock.advance(0);
    cancelled.tracker.onInput();
    await cancelled.clock.advance(200);
    expect(cancelled.probes()).toBe(1);
    expect(cancelled.tracker.running).toBe(true);
  });

  it("starts one run for a second agent_start while the first is still open", async () => {
    const { log, tracker } = setup([idle]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_start" });
    expect(log).toEqual(["start"]);
  });

  it("ignores an agent_settled that no run is waiting for", async () => {
    const { clock, log, tracker, probes } = setup([idle]);
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(300);
    expect(probes()).toBe(0);
    expect(log).toEqual([]);
  });

  it("waitIdle resolves true at the end of the run and false after its timeout", async () => {
    const { clock, tracker } = setup([idle]);
    tracker.onEvent({ type: "agent_start" });
    const late = tracker.waitIdle(50);
    await clock.advance(50);
    expect(await late).toBe(false);
    const ok = tracker.waitIdle(5000);
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(0);
    expect(await ok).toBe(true);
  });

  it("reset drops the run without recording an end, and wakes whoever waits", async () => {
    const { clock, log, tracker } = setup([busy]);
    tracker.onEvent({ type: "agent_start" });
    const waiting = tracker.waitIdle(5000);
    tracker.reset();
    expect(await waiting).toBe(true);
    expect(tracker.running).toBe(false);
    await clock.advance(1000);
    expect(log).toEqual(["start"]);
  });
});
