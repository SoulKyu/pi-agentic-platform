import { MIN_VM_MEMORY_MB, type OverviewActivity, type OverviewBox } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import { capActivities, fitsMb, isFull, sharedPercent, sortBoxes, stateOf, URGENCY } from "./rules.ts";

const NONE = { waiting: false, failed: false, running: false, starting: false };

describe("stateOf", () => {
  it("reads each fact as its own state", () => {
    expect(stateOf({ ...NONE, waiting: true })).toBe("waiting");
    expect(stateOf({ ...NONE, failed: true })).toBe("failed");
    expect(stateOf({ ...NONE, running: true })).toBe("running");
    expect(stateOf({ ...NONE, starting: true })).toBe("starting");
    expect(stateOf(NONE)).toBe("stopped");
  });

  it("keeps the priority waiting, failed, running, starting", () => {
    expect(stateOf({ waiting: true, failed: true, running: true, starting: true })).toBe("waiting");
    expect(stateOf({ waiting: false, failed: true, running: true, starting: true })).toBe("failed");
    expect(stateOf({ waiting: false, failed: false, running: true, starting: true })).toBe("running");
  });
});

const box = (name: string, state: OverviewBox["state"]): OverviewBox => ({
  ref: { kind: "agent", id: name },
  name,
  state,
  phase: null,
  activities: [],
  more: 0,
  ask: null,
  costUsd: 0,
  apiEquivalent: false,
  reservedMb: 0,
  needMb: 0,
  fits: true,
  busy: false,
  alwaysOn: false,
  nextRun: null,
});

describe("sortBoxes", () => {
  it("orders by urgency, then by name", () => {
    const sorted = sortBoxes([
      box("b-stopped", "stopped"),
      box("z-starting", "starting"),
      box("b-run", "running"),
      box("a-run", "running"),
      box("c-fail", "failed"),
      box("d-wait", "waiting"),
      box("a-stopped", "stopped"),
    ]);
    expect(sorted.map((one) => one.name)).toEqual([
      "d-wait",
      "c-fail",
      "a-run",
      "b-run",
      "z-starting",
      "a-stopped",
      "b-stopped",
    ]);
    expect(URGENCY).toEqual(["waiting", "failed", "running", "starting", "stopped"]);
  });

  it("does not reorder its input", () => {
    const input = [box("b", "stopped"), box("a", "waiting")];
    sortBoxes(input);
    expect(input.map((one) => one.name)).toEqual(["b", "a"]);
  });
});

describe("fitsMb and isFull (Review Focus 3)", () => {
  it("fits at equality and not one megabyte past", () => {
    expect(fitsMb(3072, 1024, 4096)).toBe(true);
    expect(fitsMb(3072, 1025, 4096)).toBe(false);
  });

  it("is full when the smallest VM no longer fits", () => {
    expect(MIN_VM_MEMORY_MB + VM_OVERHEAD_MB).toBe(1024);
    expect(isFull(3072, 4096)).toBe(false);
    expect(isFull(3073, 4096)).toBe(true);
  });
});

describe("sharedPercent", () => {
  it("rounds to the nearest 5 and clamps to 0..100", () => {
    expect(sharedPercent(8000, 10240)).toBe(80);
    expect(sharedPercent(10240, 10240)).toBe(100);
    expect(sharedPercent(0, 4096)).toBe(0);
    expect(sharedPercent(1000, 10240)).toBe(10);
    expect(sharedPercent(1100, 10240)).toBe(10);
    expect(sharedPercent(1400, 10240)).toBe(15);
    expect(sharedPercent(20000, 10240)).toBe(100);
  });

  it("is 0 when there is no cap", () => {
    expect(sharedPercent(512, 0)).toBe(0);
  });
});

const activity = (kind: OverviewActivity["kind"], id: string, since: number | null): OverviewActivity => ({
  kind,
  id,
  title: id,
  since,
  stoppable: kind === "task",
});

describe("capActivities", () => {
  it("keeps three, the thread first, then sessions, then tasks, each by since", () => {
    const { activities, more } = capActivities([
      activity("task", "t2", 20),
      activity("session", "s2", 40),
      activity("task", "t1", 10),
      activity("session", "s1", 30),
      activity("thread", "th", 50),
    ]);
    expect(activities.map((one) => one.id)).toEqual(["th", "s1", "s2"]);
    expect(more).toBe(2);
  });

  it("sorts a null start last within its kind and keeps a short list whole", () => {
    const { activities, more } = capActivities([
      activity("task", "late", null),
      activity("task", "early", 5),
    ]);
    expect(activities.map((one) => one.id)).toEqual(["early", "late"]);
    expect(more).toBe(0);
  });
});
