import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { FAIL_CLOSED_REASON } from "./pipeline.ts";
import { GUARD_MODEL_REASON } from "./run-guard.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const limits = { identicalCalls: 2, toolCalls: 150, turns: 60 };
const guarded =
  (guard = limits) =>
  () => ({ ...interactiveRules, guard });

describe("stage 04: the run guard", () => {
  it("turns an allowed call into a guard question, and a once answer lets the run go on", async () => {
    const h = bed.harness({ rules: guarded(), answers: [{ answer: "once", closed: false }] });
    h.runStart();
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.asks).toEqual([
      expect.objectContaining({
        answers: ["deny", "once"],
        guard: "identical-calls",
        title: "The agent repeated the same call 2 times in a row. Allow it once more?",
      }),
    ]);
    expect(h.entries.at(-1)).toMatchObject({
      decision: "approved",
      stages: [
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { stage: "04", outcome: "ask", reason: "the same call 2 times in a row" },
      ],
    });
    // Released: the next identical call starts a new streak.
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
  });

  it("blocks on a deny and on a closed question, and blocks without a UI", async () => {
    const deny = bed.harness({ rules: guarded(), answers: [{ answer: "deny", closed: false }] });
    deny.runStart();
    await deny.run("read", { path: "a" });
    expect(await deny.run("read", { path: "a" })).toEqual({ block: true, reason: GUARD_MODEL_REASON });
    expect(deny.entries.at(-1)).toMatchObject({ decision: "denied" });
    const closed = bed.harness({ rules: guarded(), answers: [{ answer: "deny", closed: true }] });
    closed.runStart();
    await closed.run("read", { path: "a" });
    expect(await closed.run("read", { path: "a" })).toMatchObject({ block: true });
    const noUi = bed.harness({ hasUI: false, rules: guarded() });
    noUi.runStart();
    await noUi.run("read", { path: "a" });
    expect(await noUi.run("read", { path: "a" })).toEqual({ block: true, reason: GUARD_MODEL_REASON });
    expect(noUi.asks).toEqual([]);
    expect(noUi.entries.at(-1)).toMatchObject({
      decision: "block",
      stages: expect.arrayContaining([
        { stage: "04", outcome: "block", reason: "the same call 2 times in a row" },
      ]),
    });
  });

  it("trips on the call past the call limit and on a call after the last turn", async () => {
    const calls = bed.harness({
      rules: guarded({ identicalCalls: 100, toolCalls: 3, turns: 60 }),
      hasUI: false,
    });
    calls.runStart();
    for (const path of ["a", "b", "c"]) expect(await calls.run("read", { path })).toBeUndefined();
    expect(await calls.run("read", { path: "d" })).toEqual({ block: true, reason: GUARD_MODEL_REASON });
    const turns = bed.harness({
      rules: guarded({ identicalCalls: 100, toolCalls: 150, turns: 1 }),
      hasUI: false,
    });
    turns.runStart();
    turns.turn();
    expect(await turns.run("read", { path: "a" })).toBeUndefined();
    turns.turn();
    expect(await turns.run("read", { path: "a" })).toEqual({ block: true, reason: GUARD_MODEL_REASON });
    turns.runStart();
    expect(await turns.run("read", { path: "a" })).toBeUndefined();
  });

  it("counts a nested call for nothing", async () => {
    const h = bed.harness({ rules: guarded(), hasUI: false });
    h.runStart();
    expect(await h.run("read", { path: "a" }, "c1")).toBeUndefined();
    expect(await h.run("read", { path: "a" }, "c2", "parent")).toBeUndefined();
    expect(await h.run("read", { path: "a" }, "c3")).toEqual({ block: true, reason: GUARD_MODEL_REASON });
  });

  it("counts a call that stage 01 blocked (a model retrying a refused call is a loop)", async () => {
    const h = bed.harness({ rules: guarded({ identicalCalls: 100, toolCalls: 2, turns: 60 }), hasUI: false });
    h.runStart();
    const refused = await h.run("bash", { command: "rm -rf /" }, "c1");
    expect(refused).toMatchObject({ block: true });
    expect(refused).not.toEqual({ block: true, reason: GUARD_MODEL_REASON });
    expect(h.entries.at(-1)).toMatchObject({
      decision: "block",
      stages: expect.arrayContaining([expect.objectContaining({ stage: "01", outcome: "block" })]),
    });
    expect(await h.run("read", { path: "a" }, "c2")).toBeUndefined();
    // Two calls were evaluated, one of them blocked: the third is past the limit.
    expect(await h.run("read", { path: "b" }, "c3")).toEqual({ block: true, reason: GUARD_MODEL_REASON });
  });

  it("a trip on a call stage 03 blocked changes nothing", async () => {
    const h = bed.harness({ rules: guarded(), hasUI: false });
    h.runStart();
    await h.run("bash", { command: "rm -rf /" });
    await h.run("bash", { command: "rm -rf /" });
    const last = h.entries.at(-1);
    expect(last).toMatchObject({ decision: "block" });
    expect(JSON.stringify(last)).not.toContain("run guard");
    expect(h.asks).toEqual([]);
  });

  it("does not count a call whose audit line could not be written", async () => {
    let failures = 1;
    const entries: unknown[] = [];
    const h = bed.harness({
      rules: guarded(),
      hasUI: false,
      audit: (entry) => {
        if (failures-- > 0) throw new Error("sink down");
        entries.push(entry);
      },
    });
    h.runStart();
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    // Only one call has proceeded: the next identical one is the first of its streak.
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: GUARD_MODEL_REASON });
  });

  it("blocks a trip that names no rule, and never commits it", async () => {
    const commits: unknown[] = [];
    const h = bed.harness({
      hasUI: false,
      stages: {
        guard: () => ({ outcome: "trip", reason: "no rule" }) as never,
        commit: (...args) => commits.push(args),
      },
    });
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(commits).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "evaluation error" });
  });

  it("writes no input text in the guard's reason", async () => {
    const h = bed.harness({ rules: guarded(), hasUI: false });
    h.runStart();
    const input = { path: "SECRET-MARKER" };
    await h.run("read", input);
    await h.run("read", input);
    // The arguments are the one field that may quote the input.
    const rest = { ...h.entries.at(-1), args: "" };
    expect(JSON.stringify(rest)).not.toContain("SECRET-MARKER");
  });
});
