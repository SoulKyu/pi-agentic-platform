import { PLATFORM_ARGS } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createRequests } from "./requests.ts";
import { createApprove } from "./ops-approve.ts";
import { createRequestsBed, papCode, type RequestsBed } from "./testing/requests-bed.ts";

let t: RequestsBed;
afterEach(() => t.bed.dispose());

const settledOf = (promise: Promise<unknown>): { done: boolean } => {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
};

describe("a waiter whose request row is gone", () => {
  it("is resolved by the close that finds no row (the agent was deleted while it waited)", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    const state = settledOf(waiting);
    await t.bed.agents.remove(t.bed.owner(), t.agentId);
    expect(t.stateOf(id)).toBeUndefined();
    expect(t.requests.cancel(id)).toBe(false);
    expect(await waiting).toBe("cancelled");
    expect(state.done).toBe(true);
    // The waiter went with it: a second close has nothing to resolve.
    expect(t.requests.expire(id)).toBe(false);
  });

  it("ends an approval whose worker died after the agent was deleted: the op answers not approved", async () => {
    t = await createRequestsBed();
    const approve = createApprove({ requests: t.requests, clock: t.bed.clock, logger: silentLogger });
    const controller = new AbortController();
    const call = approve(PLATFORM_ARGS["agent.approve"].parse({ title: "Deploy?" }), {
      ownerId: "u1",
      sessionId: "t1",
      type: "agent-thread",
      tainted: false,
      agentId: t.agentId,
      signal: controller.signal,
    });
    await t.bed.clock.advance(0);
    await t.bed.agents.remove(t.bed.owner(), t.agentId);
    controller.abort();
    expect(await call).toEqual({ approved: false });
  });
});

describe("expire and cancel on a database a newer pap wrote", () => {
  it("change nothing and say so in the log", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const frozen = createRequests({
      db: t.bed.db,
      clock: t.bed.clock,
      logger: { warn: (message: string) => void t.warnings.push(message), error: () => {} },
      items: { upsertAgentItem: () => true, resolveRef: () => true },
      audit: t.bed.audit,
      changed: () => {},
      readOnly: true,
    });
    expect(frozen.expire(id)).toBe(false);
    expect(frozen.cancel(id)).toBe(false);
    expect(t.stateOf(id)?.state).toBe("pending");
    expect(t.warnings.filter((message) => message === "agent_request_close_skipped_read_only")).toHaveLength(
      2,
    );
  });
});

describe("the owner's answer to an approval", () => {
  it("is audited first: a failing audit refuses the answer, logs it, and leaves the request open", async () => {
    t = await createRequestsBed({ auditFails: true });
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    const state = settledOf(waiting);
    expect(await papCode(() => t.requests.answer(t.bed.owner(), id, true))).toBe("internal");
    expect(t.stateOf(id)?.state).toBe("pending");
    expect(t.warnings).toContain("agent_approval_audit_failed");
    expect(t.resolved).toEqual([]);
    await Promise.resolve();
    expect(state.done).toBe(false);
    expect(t.requests.cancel(id)).toBe(true);
  });

  it("has its audit row by the time the request is closed", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const seen: number[] = [];
    const resolveRef = t.resolved.push.bind(t.resolved);
    t.resolved.push = (...entries) => {
      seen.push(t.bed.auditRows().filter((row) => row.reason === "agent approval").length);
      return resolveRef(...entries);
    };
    await t.requests.answer(t.bed.owner(), id, true);
    expect(seen).toEqual([1]);
  });

  it("is not_found after the op's own expiry, and the request stays expired", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    expect(t.requests.expire(id)).toBe(true);
    expect(await waiting).toBe("expired");
    expect(await papCode(() => t.requests.answer(t.bed.owner(), id, true))).toBe("not_found");
    expect(t.stateOf(id)?.state).toBe("expired");
    expect(t.bed.auditRows().filter((row) => row.reason === "agent approval")).toEqual([]);
  });

  it("lets exactly one of two answers at the same time win, and audits that one only", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const waiting = t.requests.wait(id);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => t.requests.answer(t.bed.owner(), id, true)),
      Promise.resolve().then(() => t.requests.answer(t.bed.owner(), id, false)),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await waiting).toBe("approved");
    expect(t.stateOf(id)?.state).toBe("approved");
    const rows = t.bed.auditRows().filter((row) => row.reason === "agent approval");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "")).toMatchObject({ approved: true });
  });

  it("is refused for any caller that is not a browser session (fail closed)", async () => {
    t = await createRequestsBed();
    const id = t.requests.open(t.input());
    const automation = testCaller({ kind: "automation" as never, credentialId: "automation" });
    expect(await papCode(() => t.requests.answer(automation, id, true))).toBe("forbidden");
    expect(t.stateOf(id)?.state).toBe("pending");
  });
});
