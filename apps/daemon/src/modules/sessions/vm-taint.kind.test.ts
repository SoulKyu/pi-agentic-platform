import { platformVerdict } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { outsideToolResultsTaint } from "./outside-taint.ts";
import { sessionKind } from "./session-kind.ts";
import type { SessionRow } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";

// What the proxy-driven taint (spec 4) does downstream: the same hook the mirror uses, then the kinds the platform ops read.
const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, ownerId: "u1", cwd: "/work", agentId: "atlas-0001", agentRole: "thread", ...extra }) as SessionRow;
const THREAD = row("thread");
const CHILD = row("child", { agentRole: "child", parentSessionId: "thread" });

function setup() {
  const policy = fakePolicyPort();
  const rows = new Map([THREAD, CHILD].map((r) => [r.id, r]));
  const taint = outsideToolResultsTaint({
    store: { get: (id) => rows.get(id) },
    policy,
    audit: { append: () => {} },
    logger: silentLogger,
  });
  const kind = (r: SessionRow) => sessionKind(r, { policy, inLane: () => false });
  return { policy, taint, kind };
}

describe("a session the proxy tainted", () => {
  it("reads tainted in its platform kind, thread and child alike", () => {
    const { taint, kind } = setup();
    expect([kind(THREAD).tainted, kind(CHILD).tainted]).toEqual([false, false]);
    taint("thread");
    taint("child");
    expect(kind(THREAD)).toMatchObject({ type: "agent-thread", tainted: true });
    expect(kind(CHILD)).toMatchObject({ type: "child", tainted: true });
  });

  it("makes a whenTainted ask op ask: refused tainted until the call is approved", () => {
    const { taint, kind } = setup();
    taint("thread");
    const { type, tainted } = kind(THREAD);
    expect(platformVerdict("agent.remind", { type, tainted, approvedCall: false })).toBe("tainted");
    expect(platformVerdict("agent.remind", { type, tainted, approvedCall: true })).toBeNull();
  });

  it("is not cleared by a worker's taint record, whatever its epoch", () => {
    const { policy, taint, kind } = setup();
    taint("thread");
    for (const epoch of [0, 1, 7]) expect(policy.markTainted("u1", "thread", epoch)).toBe(false);
    expect(kind(THREAD).tainted).toBe(true);
  });

  it("taints again without an epoch after an owner's Clear: a stale worker record cannot hide it", () => {
    const { policy, taint, kind } = setup();
    taint("thread");
    policy.clearTaint("u1", "thread");
    expect(kind(THREAD).tainted).toBe(false);
    expect(policy.markTainted("u1", "thread", 0)).toBe(false); // the worker's record predates the Clear
    taint("thread");
    expect(kind(THREAD).tainted).toBe(true);
  });
});
