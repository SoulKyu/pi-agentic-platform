import { describe, expect, it } from "vitest";
import { type RailFacts, railStateOf } from "./rail-state.ts";

const NONE: RailFacts = {
  unreadable: false,
  quarantined: false,
  paused: false,
  threadNeedsInput: false,
  requestPending: false,
  childWaiting: false,
  threadRunning: false,
  taskRunning: false,
  failedCard: false,
};
const of = (facts: Partial<RailFacts>) => railStateOf({ ...NONE, ...facts });

describe("railStateOf (M11R62)", () => {
  it("is idle when nothing is going on", () => {
    expect(of({})).toBe("idle");
  });

  it("reads each fact as its own state", () => {
    expect(of({ threadNeedsInput: true })).toBe("needs_input");
    expect(of({ requestPending: true })).toBe("needs_input");
    expect(of({ childWaiting: true })).toBe("needs_input");
    expect(of({ threadRunning: true })).toBe("running");
    expect(of({ taskRunning: true })).toBe("running");
    expect(of({ failedCard: true })).toBe("failed");
    expect(of({ paused: true })).toBe("paused");
    expect(of({ unreadable: true })).toBe("paused");
  });

  it("puts the states in order: needs_input over running over failed over paused over idle", () => {
    const everything = { threadRunning: true, failedCard: true, paused: true };
    expect(of({ ...everything, requestPending: true })).toBe("needs_input");
    expect(of(everything)).toBe("running");
    expect(of({ failedCard: true, paused: true })).toBe("failed");
    expect(of({ paused: true })).toBe("paused");
  });

  it("shows quarantined instead of all of them", () => {
    expect(
      of({
        quarantined: true,
        paused: true,
        threadNeedsInput: true,
        requestPending: true,
        threadRunning: true,
        failedCard: true,
      }),
    ).toBe("quarantined");
  });
});
