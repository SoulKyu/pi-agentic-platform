import { describe, expect, it } from "vitest";
import { fanoutView, laneView } from "../../testing/lane-fixtures.ts";
import {
  canRunTests,
  columnModels,
  formatCost,
  formatDuration,
  losersOf,
  runAgainPrefill,
  testsChip,
} from "./compare.vm.ts";

const column = (laneId: string, patch: object = {}) => ({
  laneId,
  summary: null,
  files: null,
  additions: null,
  deletions: null,
  durationMs: null,
  costUsd: null,
  ...patch,
});

describe("compare view model", () => {
  it("names a chip per test state, queued and interrupted included", () => {
    const state = (s: string, exitCode: number | null = null) =>
      testsChip({ state: s as never, exitCode, finishedAt: null });
    expect(state("passed")).toMatchObject({ tone: "ok", key: "compare.tests.passed" });
    expect(state("failed", 2)).toMatchObject({ tone: "att", key: "compare.tests.failed", code: 2 });
    expect(state("failed")).toMatchObject({ tone: "att", key: "compare.tests.failedNoCode" });
    expect(state("running")).toMatchObject({ tone: "run", key: "compare.tests.running" });
    expect(state("queued")).toMatchObject({ tone: "mut", key: "compare.tests.queued" });
    expect(state("none")).toMatchObject({ tone: "mut", key: "compare.tests.none" });
    expect(state("unapproved")).toMatchObject({ tone: "mut", key: "compare.tests.unapproved" });
    expect(state("interrupted")).toMatchObject({ tone: "att", key: "compare.tests.interrupted" });
  });

  it("writes a duration as minutes and seconds, and a cost in dollars", () => {
    expect(formatDuration(400_000)).toBe("6m40");
    expect(formatDuration(662_000)).toBe("11m02");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatCost(0.38)).toBe("$0.38");
    expect(formatCost(null)).toBe("—");
  });

  it("offers Run tests where nothing ran by itself, and not while one waits or runs", () => {
    const tests = (state: string) => ({ state: state as never, exitCode: null, finishedAt: null });
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("none") }))).toBe(true);
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("interrupted") }))).toBe(true);
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("running") }))).toBe(false);
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("queued") }))).toBe(false);
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("unapproved") }))).toBe(false);
    const issue = laneView({
      id: "a-1a2b",
      tests: tests("passed"),
      source: { kind: "issue", forge: "github", url: "https://github.com/o/r/issues/4", number: 4 },
    });
    expect(canRunTests(issue)).toBe(true);
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("passed") }))).toBe(false);
    for (const waiting of ["running", "queued", "unapproved"]) {
      expect(canRunTests({ ...issue, tests: tests(waiting) })).toBe(false);
      expect(canRunTests(laneView({ id: "a-1a2b", createdBy: "token", tests: tests(waiting) }))).toBe(false);
    }
    expect(canRunTests(laneView({ id: "a-1a2b", tests: tests("none"), state: "failed" }))).toBe(false);
  });

  it("builds one column per live lane in the group's order, with letters from the slot", () => {
    const lanes = new Map([
      ["b-1a2b", laneView({ id: "b-1a2b", fanoutSlot: 1, model: { provider: "p", modelId: "opus" } })],
      ["a-1a2b", laneView({ id: "a-1a2b", fanoutSlot: 0, firstRunEndedAt: 5 })],
    ]);
    const fan = fanoutView({ id: "f".repeat(16), laneIds: ["a-1a2b", "b-1a2b", "c-1a2b"] });
    const models = columnModels(
      fan,
      lanes,
      [column("a-1a2b", { durationMs: 400_000, costUsd: 0.38, additions: 142, deletions: 61, files: 4 })],
      "a-1a2b",
    );
    expect(models.map((m) => [m.laneId, m.letter, m.model, m.winner])).toEqual([
      ["a-1a2b", "A", null, true],
      ["b-1a2b", "B", "opus", false],
    ]);
    expect(models[0]).toMatchObject({ duration: "6m40", cost: "$0.38", diff: "+142 −61", files: "4" });
    expect(models[1]).toMatchObject({ duration: null, cost: null, diff: null, files: null });
  });

  it("lists the losers and nothing when no winner is picked", () => {
    const lanes = new Map([
      ["a-1a2b", laneView({ id: "a-1a2b" })],
      ["b-1a2b", laneView({ id: "b-1a2b" })],
    ]);
    const fan = fanoutView({ id: "f".repeat(16), laneIds: ["a-1a2b", "b-1a2b"] });
    const models = columnModels(fan, lanes, [], "a-1a2b");
    expect(losersOf(models).map((m) => m.laneId)).toEqual(["b-1a2b"]);
    expect(losersOf(columnModels(fan, lanes, [], null))).toEqual([]);
  });

  it("prefills Run again with the issue link, else the prompt, and the models in slot order", () => {
    const pick = (modelId: string) => ({ provider: "p", modelId });
    const lanes = new Map([
      ["b-1a2b", laneView({ id: "b-1a2b", fanoutSlot: 1, model: pick("opus") })],
      ["a-1a2b", laneView({ id: "a-1a2b", fanoutSlot: 0, model: null, projectRoot: "/w/p" })],
    ]);
    const fan = fanoutView({ id: "f".repeat(16), prompt: "do it", laneIds: ["a-1a2b", "b-1a2b"] });
    expect(runAgainPrefill(fan, lanes)).toEqual({
      projectRoot: "/w/p",
      text: "do it",
      models: [null, pick("opus")],
    });
    const issue = new Map(lanes);
    issue.set(
      "a-1a2b",
      laneView({
        id: "a-1a2b",
        fanoutSlot: 0,
        source: { kind: "issue", forge: "github", url: "https://github.com/o/r/issues/4", number: 4 },
      }),
    );
    expect(runAgainPrefill(fan, issue)?.text).toBe("https://github.com/o/r/issues/4");
  });
});
