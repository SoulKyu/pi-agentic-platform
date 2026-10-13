import { type ApprovalMode, type PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { DENYLIST_MODEL_REASON, denylistStage } from "./denylist.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON, TOO_LONG_REASON } from "./pipeline.ts";
import { UNCHECKED_REASON } from "./unchecked.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const TOO_COMPLEX = "command too complex for the policy check";
const TOO_LONG = "command too long for the policy check";
const PASSED = { outcome: "pass", reason: "1 command checked" } as const;
const UNREADABLE = "true;".repeat(1001);
const withMode = (approvalMode: ApprovalMode, denylist: string[] = []) => ({
  ...interactiveRules,
  approvalMode,
  denylist,
});

describe("a command the reader cannot check, in a session that can ask", () => {
  it("asks deny or once only, and runs on once", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: UNREADABLE })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("blocks with the ordinary deny reason on deny", async () => {
    const h = bed.harness({ answers: [{ answer: "deny", closed: false }] });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual({ block: true, reason: DENIED_REASON });
    expect(h.entries.at(-1)).toMatchObject({ decision: "denied" });
  });

  it("asks in full-access too, where stage 03 would allow", async () => {
    const h = bed.harness({ rules: () => withMode("full-access") });
    expect(await h.run("bash", { command: UNREADABLE })).toBeUndefined();
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"]]);
    expect(h.entries.at(-1)?.stages[2]).toEqual({ stage: "03", outcome: "ask", reason: UNCHECKED_REASON });
  });

  it("records stage 01 as ask with the reader's reason", async () => {
    const h = bed.harness();
    await h.run("bash", { command: UNREADABLE });
    expect(h.entries.at(-1)?.stages[0]).toEqual({ stage: "01", outcome: "ask", reason: TOO_COMPLEX });
  });

  it("follows the unchecked reason with the reason of a stage 03 that asked", async () => {
    const h = bed.harness({
      stages: {
        approval: async () => ({
          outcome: "ask",
          reason: "exec asks",
          answers: ["deny", "once", "session"],
          grantable: true,
        }),
      },
    });
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
    expect(h.entries.at(-1)?.stages[2]).toEqual({
      stage: "03",
      outcome: "ask",
      reason: `${UNCHECKED_REASON} exec asks`,
    });
  });

  it("still blocks when stage 03 blocks", async () => {
    const h = bed.harness({
      stages: { approval: async () => ({ outcome: "block", reason: "no", modelReason: "stage 03 says no" }) },
    });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual({ block: true, reason: "stage 03 says no" });
    expect(h.asks).toEqual([]);
  });

  it("still blocks when stage 02 blocks", async () => {
    const h = bed.harness({
      stages: { egress: () => ({ outcome: "block", reason: "host", modelReason: "stage 02 says no" }) },
    });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual({ block: true, reason: "stage 02 says no" });
    expect(h.asks).toEqual([]);
  });

  it("keeps the taint in the same single question", async () => {
    const h = bed.harness({ taint: true });
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ tainted: true, answers: ["deny", "once"] });
  });

  it("asks again each time: a session grant does not skip it", async () => {
    let readable = true;
    const h = bed.harness({
      answers: [{ answer: "session", closed: false }],
      stages: { denylist: (call) => (readable ? PASSED : denylistStage(call)) },
    });
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks).toHaveLength(1);
    readable = false;
    expect(await h.run("bash", { command: UNREADABLE }, "c2")).toBeUndefined();
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]?.answers).toEqual(["deny", "once"]);
  });

  it("asks again each time: an always rule for the exact key does not skip it", async () => {
    const key = grantKey("bash", grantPayload({ command: UNREADABLE }, true));
    let readable = true;
    const h = bed.harness({
      rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "bash", key }] }),
      stages: { denylist: (call) => (readable ? PASSED : denylistStage(call)) },
    });
    await h.run("bash", { command: UNREADABLE });
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "always rule" });
    readable = false;
    expect(await h.run("bash", { command: UNREADABLE }, "c2")).toBeUndefined();
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"]]);
  });

  it("asks when the owner's patterns run out of budget on a command the reader could read", async () => {
    const letterRun = `*${"a".repeat(64)}b`;
    const h = bed.harness({
      rules: () =>
        withMode(
          "auto-accept-edits",
          Array.from({ length: 64 }, () => letterRun),
        ),
    });
    expect(await h.run("bash", { command: "a".repeat(10_000) })).toBeUndefined();
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"]]);
    expect(h.entries.at(-1)?.stages[0]).toEqual({ stage: "01", outcome: "ask", reason: TOO_COMPLEX });
  });

  it("does not ask twice when the rules move while the question is open", async () => {
    let version = 0;
    const h = bed.harness({
      rulesVersion: () => version,
      ask: async () => {
        version++;
        return { answer: "once", closed: false };
      },
    });
    expect(await h.run("bash", { command: UNREADABLE })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("blocks a call too long to show, whatever the reader said", async () => {
    const h = bed.harness();
    const command = "zz".repeat(32_768) + "z";
    expect(await h.run("bash", { command })).toEqual({ block: true, reason: TOO_LONG_REASON });
    expect(h.entries.at(-1)?.stages[0]).toEqual({ stage: "01", outcome: "ask", reason: TOO_LONG });
    expect(h.asks).toEqual([]);
  });
});

describe("a command the reader cannot check, in a session that cannot ask", () => {
  const blocked = { block: true, reason: TOO_COMPLEX };
  const cases: ReadonlyArray<readonly [string, Parameters<typeof bed.harness>[0]]> = [
    ["read-only", { rules: () => withMode("read-only") }],
    ["no UI", { hasUI: false }],
    [
      "a profile that is not interactive",
      { rules: () => ({ ...interactiveRules, profile: "isolated-task" }) as unknown as PolicyRules },
    ],
  ];
  it.each(cases)("blocks exactly as before: %s", async (_name, options) => {
    const h = bed.harness({ ...options, stages: ALLOW_03 });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual(blocked);
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)?.stages).toEqual([
      { stage: "01", outcome: "block", reason: TOO_COMPLEX },
      { stage: "02", outcome: "skip", reason: "blocked at stage 01" },
      { stage: "03", outcome: "skip", reason: "blocked at stage 01" },
      { stage: "04", outcome: "skip", reason: "blocked at stage 01" },
    ]);
  });

  it("blocks a command that is too long the same way", async () => {
    const h = bed.harness({ hasUI: false, stages: ALLOW_03 });
    expect(await h.run("bash", { command: "zz".repeat(32_768) + "z" })).toEqual({
      block: true,
      reason: TOO_LONG,
    });
  });
});

describe("what stays a block", () => {
  const modes: readonly ApprovalMode[] = ["read-only", "supervised", "auto-accept-edits", "full-access"];
  it.each(modes)("a built-in hit in a readable command, in %s", async (mode) => {
    const h = bed.harness({ rules: () => withMode(mode), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "echo a; rm -rf /" })).toEqual({
      block: true,
      reason: DENYLIST_MODEL_REASON,
    });
    expect(h.asks).toEqual([]);
  });

  it.each(modes)("an owner-pattern hit in a readable command, in %s", async (mode) => {
    const h = bed.harness({ rules: () => withMode(mode, ["pap-test-blocked *"]), stages: ALLOW_03 });
    expect(await h.run("bash", { command: "echo a; pap-test-blocked now" })).toEqual({
      block: true,
      reason: DENYLIST_MODEL_REASON,
    });
    expect(h.asks).toEqual([]);
  });

  it("a fork bomb inside a command the reader cannot check", async () => {
    const h = bed.harness({ stages: ALLOW_03 });
    expect(await h.run("bash", { command: `:(){ :|:& };:${";true".repeat(1001)}` })).toEqual({
      block: true,
      reason: DENYLIST_MODEL_REASON,
    });
    expect(h.asks).toEqual([]);
  });

  it("a stage 02 that returns unchecked (fail closed)", async () => {
    const h = bed.harness({
      stages: { egress: () => ({ outcome: "unchecked", reason: "r", modelReason: "m" }) },
    });
    expect(await h.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.asks).toEqual([]);
  });
});
