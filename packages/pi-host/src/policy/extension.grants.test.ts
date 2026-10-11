import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "../approvals.ts";
import { createPolicyBed } from "../testing/policy-bed.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON } from "./extension.ts";

let bed: Awaited<ReturnType<typeof createPolicyBed>>;
beforeEach(async () => {
  bed = await createPolicyBed();
});
afterEach(async () => {
  await bed.dispose();
});

describe("pap-policy approval channel", () => {
  it("asks the policy's own question and runs on once", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    expect(h.asks).toEqual([
      expect.objectContaining({
        category: "exec",
        tool: "bash",
        answers: ["deny", "once"],
        key: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(h.audits.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("blocks with the deny reason on deny, and fails closed when the question is closed or cancelled (M2-RT-22)", async () => {
    expect(
      await bed.harness({ answers: [{ answer: "deny", closed: false }] }).run("bash", { command: "ls" }),
    ).toEqual({ block: true, reason: DENIED_REASON });
    const closed = bed.harness({ answers: [{ answer: "deny", closed: true }] });
    expect(await closed.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(closed.audits.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
  });

  it("treats a closed question as closed even when it carries another answer", async () => {
    const h = bed.harness({ answers: [{ answer: "once", closed: true }] });
    expect(await h.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  });

  it("gives the same key to the same call and another to any other", async () => {
    const h = bed.harness();
    await h.run("bash", { command: "ls" });
    await h.run("bash", { command: "ls", timeout: 5 });
    await h.run("bash", { command: "ls " });
    await h.run("mcp__x__y", { a: 1, b: 2 });
    await h.run("mcp__x__y", { b: 2, a: 1 });
    const [ls, same, other, json, reordered] = h.asks.map((ask) => ask.key);
    expect(same).toBe(ls);
    expect(other).not.toBe(ls);
    expect(reordered).toBe(json);
  });

  it("blocks and never asks when the input is too deep for a grant key (fail closed)", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    const h = bed.harness();
    expect(await h.run("mcp__x__y", { deep })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.asks).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ decision: "block", reason: "evaluation error" });
  });

  it("treats a request the channel refuses as closed: nothing is sent, the call is blocked", async () => {
    const sent: unknown[] = [];
    const approvals = createApprovals((record) => sent.push(record) > 0, { newId: () => "a1" });
    const h = bed.harness({ ask: (request, signal) => approvals.ask(request, signal) });
    // An empty tool name fails the record's schema (`tool` has a minimum length).
    expect(await h.run("", { x: 1 })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(sent).toEqual([]);
    expect(approvals.pendingCount()).toBe(0);
    expect(h.audits.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
  });

  it("fails closed when the run is stopped while the question is open", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const controller = new AbortController();
    const h = bed.harness({
      ask: (request, signal) => approvals.ask(request, signal),
      signal: controller.signal,
    });
    const running = h.run("bash", { command: "ls" });
    await vi.waitFor(() => expect(approvals.pendingCount()).toBe(1));
    controller.abort();
    expect(await running).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.audits.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
    expect(approvals.pendingCount()).toBe(0);
  });

  it("audits the edit review's reason next to the answer", async () => {
    const h = bed.harness();
    const target = `${bed.outside}/a.txt`;
    expect(await h.run("write", { path: target, content: "x" })).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({
      decision: "approved",
      reason: "answer: once; outside the session directory",
    });
  });
});
