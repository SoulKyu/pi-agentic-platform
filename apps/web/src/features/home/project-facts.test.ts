import { describe, expect, it } from "vitest";
import { modeReasons } from "./project-facts.ts";

const counts = (patch: { paused?: boolean; budgetUsd?: number | null } = {}) => ({
  paused: patch.paused ?? false,
  slots: 2,
  running: 0,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: patch.budgetUsd ?? null,
});

describe("modeReasons (§3.2 ask, don't hide; PH12)", () => {
  it("disables Lane and Fan-out only once the folder is known not to be a repository", () => {
    expect(modeReasons({ git: null, counts: null })).toEqual({});
    expect(modeReasons({ git: true, counts: counts() })).toEqual({});
    expect(modeReasons({ git: false, counts: null })).toEqual({
      lane: "home.reason.notGit",
      fanout: "home.reason.notGit",
    });
  });

  it("disables Trigger while automation is paused, or with a $0 daily budget", () => {
    expect(modeReasons({ git: true, counts: counts({ paused: true }) })).toEqual({
      trigger: "home.reason.paused",
    });
    expect(modeReasons({ git: true, counts: counts({ budgetUsd: 0 }) })).toEqual({
      trigger: "home.reason.noBudget",
    });
    expect(modeReasons({ git: true, counts: counts({ budgetUsd: 5 }) })).toEqual({});
  });
});
