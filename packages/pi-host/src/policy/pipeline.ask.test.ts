import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON, TOO_LONG_REASON } from "./pipeline.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const trip = { outcome: "trip", rule: "tool-calls", reason: "150 calls in this run" } as const;

describe("the question", () => {
  it("blocks when there is no UI to ask", async () => {
    const h = bed.harness({ hasUI: false });
    expect(await h.run("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "pap-policy blocked this exec call.",
    });
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "no UI to ask" });
    expect(h.asks).toEqual([]);
  });

  it("blocks a call too long to review without asking", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: "x".repeat(40_000) })).toEqual({
      block: true,
      reason: TOO_LONG_REASON,
    });
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "too long to review" });
    expect(h.asks).toEqual([]);
  });

  it("denies, and closes, as M2 did", async () => {
    const denied = bed.harness({ answers: [{ answer: "deny", closed: false }] });
    expect(await denied.run("bash", { command: "ls" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(denied.entries.at(-1)).toMatchObject({ decision: "denied" });
    const closed = bed.harness({ answers: [{ answer: "deny", closed: true }] });
    expect(await closed.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(closed.entries.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
  });

  it("remembers a session answer for the exact call only", async () => {
    const h = bed.harness({ answers: [{ answer: "session", closed: false }] });
    await h.run("bash", { command: "ls" });
    await h.run("bash", { command: "ls" }, "c2");
    await h.run("bash", { command: "ls -a" }, "c3");
    expect(h.asks.map((ask) => ask.message.split("\n").at(-1))).toEqual(["bash: ls", "bash: ls -a"]);
    expect(h.entries[1]).toMatchObject({ decision: "allow", reason: "session rule" });
  });

  it("passes the taint and the category to the question", async () => {
    const h = bed.harness({ taint: true });
    await h.run("bash", { command: "ls" });
    expect(h.asks[0]).toMatchObject({
      category: "exec",
      tainted: true,
      tool: "bash",
      answers: ["deny", "session", "always", "once"],
    });
  });
});

describe("the guard slot", () => {
  it("turns an allowed call into a question that only offers deny and once", async () => {
    const commits: unknown[][] = [];
    const h = bed.harness({
      stages: {
        guard: () => trip,
        commit: (_call, decision, released) => commits.push([decision, released]),
      },
    });
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    expect(h.asks[0]).toMatchObject({ guard: "tool-calls", answers: ["deny", "once"] });
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
    expect(h.entries.at(-1)?.stages.at(-1)).toEqual({
      stage: "04",
      outcome: "ask",
      reason: "150 calls in this run",
    });
    expect(commits).toEqual([["approved", "tool-calls"]]);
  });

  it("does not let a session grant skip a guard question", async () => {
    let tripping = false;
    const h = bed.harness({
      answers: [{ answer: "session", closed: false }],
      stages: { guard: () => (tripping ? trip : { outcome: "pass" }) },
    });
    await h.run("bash", { command: "ls" });
    await h.run("bash", { command: "ls" }, "c2");
    expect(h.asks).toHaveLength(1);
    tripping = true;
    await h.run("bash", { command: "ls" }, "c3");
    expect(h.asks).toHaveLength(2);
  });

  it("blocks a trip when there is no UI, and releases nothing on a denial", async () => {
    const commits: unknown[][] = [];
    const noUi = bed.harness({ hasUI: false, stages: { guard: () => trip } });
    expect(await noUi.run("read", { path: "a" })).toMatchObject({ block: true });
    expect(noUi.entries.at(-1)?.stages.at(-1)).toMatchObject({ stage: "04", outcome: "block" });
    const denied = bed.harness({
      answers: [{ answer: "deny", closed: false }],
      stages: { guard: () => trip, commit: (_c, decision, released) => commits.push([decision, released]) },
    });
    await denied.run("read", { path: "a" });
    expect(commits).toEqual([["denied", null]]);
  });

  it("reports the final decision to commit, once per call", async () => {
    const decisions: string[] = [];
    const h = bed.harness({ stages: { commit: (_call, decision) => decisions.push(decision) } });
    await h.run("read", { path: "a" });
    await h.run("bash", { command: "ls" });
    expect(decisions).toEqual(["allow", "approved"]);
  });
});
