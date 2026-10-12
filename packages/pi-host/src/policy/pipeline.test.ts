import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { FAIL_CLOSED_REASON } from "./pipeline.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

type Harness = ReturnType<typeof bed.harness>;
const verdicts = (h: Harness) =>
  h.entries.at(-1)?.kind === "call" ? h.entries.at(-1)?.stages.map((v) => `${v.stage}:${v.outcome}`) : [];

describe("the pipeline", () => {
  it("runs stages 01–04 in order and writes one call entry with every verdict", async () => {
    const h = bed.harness();
    expect(await h.run("read", { path: "src/a.ts" })).toBeUndefined();
    expect(h.entries).toEqual([
      {
        kind: "call",
        toolCallId: "c1",
        tool: "read",
        category: "read",
        decision: "allow",
        reason: "read allowed",
        stages: [
          { stage: "01", outcome: "skip", reason: "not in force" },
          { stage: "02", outcome: "skip", reason: "no egress list" },
          { stage: "03", outcome: "allow", reason: "read allowed" },
          { stage: "04", outcome: "pass" },
        ],
        args: '{"path":"src/a.ts"}',
      },
    ]);
  });

  it("stops at the first block and marks the later stages skipped", async () => {
    const h = bed.harness({
      stages: {
        denylist: () => ({
          outcome: "block",
          reason: "denied: rm -rf /",
          modelReason: "pap blocked this command.",
        }),
      },
    });
    expect(await h.run("bash", { command: "rm -rf /" })).toEqual({
      block: true,
      reason: "pap blocked this command.",
    });
    expect(verdicts(h)).toEqual(["01:block", "02:skip", "03:skip", "04:skip"]);
    expect(h.asks).toEqual([]);
  });

  it("runs the denylist before the egress stage", async () => {
    const order: string[] = [];
    const h = bed.harness({
      stages: {
        denylist: () => (order.push("01"), { outcome: "pass" }),
        egress: () => (order.push("02"), { outcome: "pass" }),
        approval: async () => (order.push("03"), { outcome: "allow", reason: "ok" }),
        guard: () => (order.push("04"), { outcome: "pass" }),
      },
    });
    await h.run("read", { path: "a" });
    expect(order).toEqual(["01", "02", "03", "04"]);
  });

  it("asks once with the merged reasons, and records the answer under stage 03", async () => {
    const h = bed.harness({ answers: [{ answer: "once", closed: false }] });
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
    expect(verdicts(h)).toEqual(["01:skip", "02:skip", "03:ask", "04:pass"]);
  });

  it("blocks every call while the rules are null, and says why (M5R11)", async () => {
    const h = bed.harness({ rules: () => null });
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "no valid policy rules" });
    expect(verdicts(h)).toEqual(["01:skip", "02:skip", "03:block", "04:skip"]);
  });

  it("re-evaluates an auto-allowed call when the rules moved during its evaluation, then blocks after three tries (M5R12)", async () => {
    let version = 0;
    const evaluated: number[] = [];
    const h = bed.harness({
      rulesVersion: () => version,
      stages: {
        approval: async () => {
          evaluated.push(version);
          version++;
          return { outcome: "allow", reason: "read allowed" };
        },
      },
    });
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(evaluated).toEqual([0, 1, 2]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "policy changed during evaluation" });
    // A version that moves once is absorbed by the second try.
    let moved = false;
    const once = bed.harness({
      rulesVersion: () => (moved ? 1 : 0),
      stages: { approval: async () => ((moved = true), { outcome: "allow", reason: "read allowed" }) },
    });
    expect(await once.run("read", { path: "a" })).toBeUndefined();
    expect(once.entries).toHaveLength(1);
  });

  it("audits a nested call with its parent (M5R14)", async () => {
    const h = bed.harness();
    await h.run("read", { path: "a" }, "p1/1", "p1");
    expect(h.entries.at(-1)).toMatchObject({ toolCallId: "p1/1", parentToolCallId: "p1" });
  });

  it("blocks when the audit sink throws, and when it throws again inside the fallback", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = bed.harness({
      audit: () => {
        throw new Error("ipc gone");
      },
    });
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    vi.restoreAllMocks();
  });

  it("asks the restore slot only for a call that runs, and records what it restored (M5R10)", async () => {
    const restored: string[] = [];
    const h = bed.harness({
      stages: {
        restore: (call) => (restored.push(call.event.toolName), call.event.toolName === "write" ? 2 : 0),
      },
    });
    await h.run("write", { path: join(bed.cwd, "a.txt"), content: "x" });
    expect(h.entries.at(-1)?.kind === "call" && h.entries.at(-1)?.stages.at(-1)).toEqual({
      stage: "06",
      outcome: "acted",
      reason: "2 secret markers restored",
    });
    await h.run("read", { path: "a" });
    expect(verdicts(h)).toEqual(["01:skip", "02:skip", "03:allow", "04:pass"]);
    const blocked = bed.harness({
      rules: () => null,
      stages: { restore: (call) => (restored.push(`blocked:${call.event.toolName}`), 1) },
    });
    await blocked.run("write", { path: join(bed.cwd, "a.txt"), content: "x" });
    const refused = bed.harness({
      stages: {
        denylist: () => ({ outcome: "block", reason: "denied", modelReason: "denied" }),
        restore: (call) => (restored.push(`refused:${call.event.toolName}`), 1),
      },
    });
    await refused.run("write", { path: join(bed.cwd, "a.txt"), content: "x" });
    const denied = bed.harness({
      answers: [{ answer: "deny", closed: false }],
      stages: { restore: (call) => (restored.push(`denied:${call.event.toolName}`), 1) },
    });
    await denied.run("bash", { command: "ls" });
    expect(restored).toEqual(["write", "read"]);
  });
});
