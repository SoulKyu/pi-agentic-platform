import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "../approvals.ts";
import { createPolicyBed } from "../testing/policy-bed.ts";
import {
  answersFor,
  createPolicyGrants,
  DENIED_REASON,
  FAIL_CLOSED_REASON,
  MAX_SESSION_GRANTS,
} from "./extension.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import { interactiveRules } from "../testing/policy-bed.ts";

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
        answers: ["deny", "session", "always", "once"],
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

  it("keys a call as a command only for the built-in shell tool, not for an extension that took its name", async () => {
    const builtin = bed.harness({ isBuiltinTool: () => true });
    const taken = bed.harness({ isBuiltinTool: () => false });
    await builtin.run("bash", { command: "ls" });
    await taken.run("bash", { command: "ls" });
    expect(builtin.asks[0]?.category).toBe("exec");
    expect(taken.asks[0]?.category).toBe("unknown");
    expect(builtin.asks[0]?.key).toBe(grantKey("bash", { kind: "cmd", payload: "ls" }));
    expect(taken.asks[0]?.key).toBe(grantKey("bash", grantPayload({ command: "ls" }, false)));
    expect(taken.asks[0]?.key).not.toBe(builtin.asks[0]?.key);
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
    await vi.waitFor(() => expect(approvals.pendingCount()).toBe(1), { timeout: 5000 });
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

describe("pap-policy grants", () => {
  it("asks once, then lets the identical call through for the rest of the worker's life on a session answer", async () => {
    const h = bed.harness({ answers: [{ answer: "session", closed: false }] });
    expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
    expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.audits.at(-1)).toMatchObject({ decision: "allow", reason: "session rule" });
    await h.run("bash", { command: "npm test " });
    expect(h.asks).toHaveLength(2);
  });

  it("lets a call through on a project's always rule, matching the exact call only", async () => {
    const key = grantKey("bash", grantPayload({ command: "npm test" }, true));
    const h = bed.harness({
      rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "bash", key }] }),
      answers: [{ answer: "deny", closed: false }],
    });
    expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({ decision: "allow", reason: "always rule" });
    expect(await h.run("bash", { command: "npm  test" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "session", "always", "once"]]);
  });

  it("does not let a rule of another tool allow the call, even with the same key", async () => {
    const key = grantKey("bash", grantPayload({ command: "npm test" }, true));
    const h = bed.harness({
      rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "other", key }] }),
      answers: [{ answer: "deny", closed: false }],
    });
    expect(await h.run("bash", { command: "npm test" })).toEqual({ block: true, reason: DENIED_REASON });
  });

  it("never keeps an always answer past a policy update that dropped it (M2-RT-01)", async () => {
    let version = 0;
    const h = bed.harness({
      answers: [
        { answer: "always", closed: false },
        { answer: "deny", closed: false },
      ],
      rulesVersion: () => version,
    });
    expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
    // Before the daemon's push: the provisional grant covers the same call.
    expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.audits.at(-1)).toMatchObject({ decision: "allow", reason: "always rule" });
    // The daemon's push without the rule (it was revoked): the answer is gone, the call asks again.
    version++;
    expect(await h.run("bash", { command: "rm -rf build" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(h.asks).toHaveLength(2);
  });

  it("ends an always answer when updates land while its question was open (add, then revoke)", async () => {
    let version = 0;
    const h = bed.harness({
      rulesVersion: () => version,
      ask: async () => {
        // What a worker sees when the answer, the add push and a revoke push arrive in one read.
        version += 2;
        return { answer: "always", closed: false };
      },
    });
    expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
    expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
    expect(h.asks).toHaveLength(2);
    expect(h.audits.at(-1)).toMatchObject({ decision: "approved", reason: "answer: always" });
  });

  it("pins the answers of every category", () => {
    expect(
      (["read", "edit", "exec", "network", "external-write", "unknown"] as const).map((category) =>
        answersFor(category, undefined),
      ),
    ).toEqual([
      ["deny", "session", "always", "once"],
      ["deny", "session", "always", "once"],
      ["deny", "session", "always", "once"],
      ["deny", "session", "always", "once"],
      ["deny", "session", "always", "once"],
      ["deny", "session", "once"],
    ]);
  });

  it("offers a network call all four answers", async () => {
    const h = bed.harness({ answers: [{ answer: "deny", closed: false }] });
    await h.run("web_fetch", { url: "https://example.com" });
    expect(h.asks[0]).toMatchObject({ category: "network", answers: ["deny", "session", "always", "once"] });
  });

  it("does not turn an always answer into a session grant", async () => {
    let version = 0;
    const h = bed.harness({ answers: [{ answer: "always", closed: false }], rulesVersion: () => version });
    await h.run("bash", { command: "ls -l" });
    version++;
    await h.run("bash", { command: "ls -l" });
    expect(h.asks).toHaveLength(2);
    expect(h.audits.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("never lets a grant cover a write outside the project or to a protected path", async () => {
    const input = { path: join(bed.cwd, ".git", "hooks", "pre-commit"), content: "x" };
    const key = grantKey("write", grantPayload(input, false));
    const h = bed.harness({
      rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "write", key }] }),
      answers: [
        { answer: "session", closed: false },
        { answer: "once", closed: false },
      ],
    });
    await h.run("write", input);
    await h.run("write", input);
    expect(h.asks.map((ask) => ask.answers)).toEqual([
      ["deny", "once"],
      ["deny", "once"],
    ]);
  });

  it("offers no always answer for a tool it cannot classify", async () => {
    const h = bed.harness({ answers: [{ answer: "deny", closed: false }], isBuiltinTool: () => false });
    await h.run("mystery_tool", { x: 1 });
    expect(h.asks[0]?.answers).toEqual(["deny", "session", "once"]);
  });

  it("keeps at most MAX_SESSION_GRANTS session grants, dropping the oldest", async () => {
    const h = bed.harness({
      answers: Array.from({ length: MAX_SESSION_GRANTS + 2 }, () => ({
        answer: "session" as const,
        closed: false,
      })),
    });
    for (let i = 0; i <= MAX_SESSION_GRANTS; i++) await h.run("bash", { command: `echo ${i}` });
    await h.run("bash", { command: "echo 0" });
    expect(h.asks).toHaveLength(MAX_SESSION_GRANTS + 2);
    // The newest is still granted.
    await h.run("bash", { command: `echo ${MAX_SESSION_GRANTS}` });
    expect(h.asks).toHaveLength(MAX_SESSION_GRANTS + 2);
  });
});

describe("createPolicyGrants", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

  it("caps the provisional always grants at MAX_SESSION_GRANTS, dropping the oldest", () => {
    const grants = createPolicyGrants(() => 0);
    for (const key of keys(MAX_SESSION_GRANTS + 1)) grants.rememberAlways(key, grants.version());
    expect(grants.hasProvisionalAlways("k0")).toBe(false);
    expect(grants.hasProvisionalAlways("k1")).toBe(true);
    expect(grants.hasProvisionalAlways(`k${MAX_SESSION_GRANTS}`)).toBe(true);
  });

  it("drops the oldest session grant at its cap, and a repeated one counts as the newest", () => {
    const grants = createPolicyGrants(() => 0, 3);
    for (const key of ["a", "b", "c"]) grants.rememberSession(key);
    grants.rememberSession("a");
    grants.rememberSession("d");
    expect(["a", "b", "c", "d"].map((key) => grants.hasSession(key))).toEqual([true, false, true, true]);
  });

  it("ends every provisional grant when the version moves, and keeps session grants", () => {
    let version = 4;
    const grants = createPolicyGrants(() => version);
    grants.rememberAlways("x", grants.version());
    grants.rememberSession("y");
    version = 5;
    expect(grants.hasProvisionalAlways("x")).toBe(false);
    expect(grants.hasSession("y")).toBe(true);
  });
});
