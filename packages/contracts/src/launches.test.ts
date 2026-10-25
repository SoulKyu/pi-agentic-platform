import { describe, expect, it } from "vitest";
import {
  LAUNCH_STEPS,
  LAUNCH_STEP_LIMITS_MS,
  LaunchEnd,
  LaunchStepState,
  LaunchView,
  LaunchesStreamEvent,
  methods,
} from "./index.ts";

const box = { kind: "project", id: "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0" };
const step = (name: string, state: string) => ({
  step: name,
  state,
  startedAt: null,
  endedAt: null,
  usualMs: null,
  deadlineAt: null,
  detail: null,
});
const view = (steps: unknown[]) => ({ id: "l1", box, for: "start", startedAt: 1, steps });

describe("launches contracts", () => {
  it("a launch view parses with every step state and refuses an unknown step", () => {
    const states = LaunchStepState.options;
    expect(states).toEqual(["pending", "running", "done", "skipped", "failed"]);
    const steps = LAUNCH_STEPS.map((name, index) => step(name, states[index % states.length] ?? "pending"));
    expect(LaunchView.safeParse(view(steps)).success).toBe(true);
    expect(LaunchView.safeParse(view([step("boot", "running")])).success).toBe(false);
    expect(LaunchView.safeParse(view([step("vm", "sleeping")])).success).toBe(false);
  });

  it("carries a waiting reason and refuses an unknown one", () => {
    const waiting = { reason: "session_slots", used: 4, max: 4, nextTryAt: 9 };
    expect(LaunchView.safeParse({ ...view([]), waiting }).success).toBe(true);
    expect(LaunchView.safeParse({ ...view([]), waiting: { reason: "tired" } }).success).toBe(false);
  });

  it("an end event carries ok and an optional code", () => {
    expect(LaunchEnd.safeParse({ id: "l1", done: true, ok: true }).success).toBe(true);
    expect(LaunchEnd.safeParse({ id: "l1", done: true, ok: false, code: "capacity" }).success).toBe(true);
    expect(LaunchEnd.safeParse({ id: "l1", done: false, ok: true }).success).toBe(false);
    expect(LaunchEnd.safeParse({ id: "l1", done: true }).success).toBe(false);
    expect(LaunchesStreamEvent.safeParse({ kind: "end", id: "l1", done: true, ok: true }).success).toBe(true);
  });

  it("parses the four stream events", () => {
    const helpers = { active: 1, max: 4, waiting: 0 };
    const events = [
      { kind: "snapshot", launches: [view([])], helpers },
      { kind: "launch", launch: view([step("checks", "running")]) },
      { kind: "helpers", helpers },
    ];
    for (const event of events) expect(LaunchesStreamEvent.safeParse(event).success).toBe(true);
    expect(LaunchesStreamEvent.safeParse({ kind: "snapshot", launches: [] }).success).toBe(false);
  });

  it("keeps the step limits the brief fixes", () => {
    expect(LAUNCH_STEP_LIMITS_MS).toEqual({
      checks: 30_000,
      image: 1_800_000,
      disk: 600_000,
      vm: 60_000,
      guest: 60_000,
      worker: 30_000,
    });
  });

  it("declares launches.log and subscribe.launches for sessions:read", () => {
    expect(methods["launches.log"]).toMatchObject({ permission: "sessions:read", idempotent: true });
    expect(methods["subscribe.launches"]).toMatchObject({ permission: "sessions:read", idempotent: true });
    expect(methods["launches.log"].params.safeParse({ box }).success).toBe(true);
    expect(methods["launches.log"].result.safeParse({ lines: ["a"] }).success).toBe(true);
  });
});
