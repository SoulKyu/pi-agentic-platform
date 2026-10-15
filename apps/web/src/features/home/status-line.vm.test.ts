import { describe, expect, it } from "vitest";
import { taskView, usageSummary } from "../../testing/home-fixtures.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { statusParts } from "./status-line.vm.ts";

const api = { id: "p1", root: "/w/api" };
const lanes = [
  laneView({ id: "a-1a2b", projectRoot: "/w/api" }),
  laneView({ id: "b-1a2b", projectRoot: "/w/api", state: "creating" }),
  laneView({ id: "c-1a2b", projectRoot: "/w/web" }),
];
const tasks = [
  taskView({ id: "t1", state: "running" }),
  taskView({ id: "t2", state: "running", projectId: "p2" }),
  taskView({ id: "t3", state: "queued" }),
];

describe("statusParts (§3.3)", () => {
  it("counts the project's active lanes and running tasks, the owner's unread items, and the 30-day spend", () => {
    expect(
      statusParts({ project: api, lanes, tasks, unread: 3, spend: usageSummary({ costUsd: 4.2, runs: 2 }) }),
    ).toEqual([
      { kind: "lanes", count: 1 },
      { kind: "tasks", count: 1 },
      { kind: "inbox", count: 3 },
      { kind: "spend", usd: 4.2, none: false, apiEquivalent: false },
    ]);
  });

  it("counts every project under All projects", () => {
    expect(statusParts({ project: null, lanes, tasks, unread: 0, spend: null })).toEqual([
      { kind: "lanes", count: 2 },
      { kind: "tasks", count: 2 },
    ]);
  });

  it("leaves out a part with nothing to show, never the spend, and notes a subscription's figure", () => {
    expect(statusParts({ project: api, lanes: [], tasks: [], unread: 0, spend: usageSummary() })).toEqual([
      { kind: "spend", usd: 0, none: true, apiEquivalent: false },
    ]);
    expect(
      statusParts({
        project: api,
        lanes: [],
        tasks: [],
        unread: 0,
        spend: usageSummary({ costUsd: 1, runs: 1, billing: "subscription" }),
      }),
    ).toEqual([{ kind: "spend", usd: 1, none: false, apiEquivalent: true }]);
  });
});
