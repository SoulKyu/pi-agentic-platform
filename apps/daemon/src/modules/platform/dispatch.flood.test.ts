import { AUDIT_RATE_LIMIT_REASON } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditModule } from "../audit/index.ts";
import { createAuditBed } from "../audit/testing/bed.ts";
import { createPlatformPort } from "./index.ts";

let bed: ReturnType<typeof createAuditBed>;
afterEach(() => bed.dispose());

function open() {
  bed = createAuditBed();
  const audit = createAuditModule({ db: bed.db, clock: bed.clock, logger: bed.logger });
  const port = createPlatformPort({
    sessions: {
      kindOf: () => ({ ownerId: "u1", type: "agent-thread", tainted: false, agentId: "atlas-0001" }),
      approvedCalls: { take: () => false },
    },
    audit: audit.port,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
  });
  const handler = vi.fn(() => Promise.resolve({ itemId: "i1" }));
  port.register("agent.notify", handler as never);
  const replies: Array<{ id: string; error?: string }> = [];
  const call = (id: string, op: "lane.note" | "agent.notify", args: unknown) =>
    port.onRecord(
      { id: "s1", ownerId: "u1" },
      { type: "platform_call", id, op, toolCallId: "tc", args },
      (record) => replies.push(record),
    );
  const rows = () =>
    bed.db.all<{ kind: string; reason: string; decision: string }>(
      "SELECT kind, reason, decision FROM audit ORDER BY id",
    );
  return { handler, replies, call, rows };
}

describe("a worker that floods refused calls", () => {
  it("cannot hide an op that would run: the 121st call answers rate_limited and runs nothing", async () => {
    const { handler, replies, call, rows } = open();
    for (let i = 0; i < 120; i++) call(`f${i}`, "lane.note", { note: "x" });
    expect(rows()).toHaveLength(120);
    call("ok1", "agent.notify", { text: "hello" });
    await bed.clock.advance(0);
    expect(handler).not.toHaveBeenCalled();
    expect(replies.at(-1)).toEqual({ type: "platform_result", id: "ok1", ok: false, error: "rate_limited" });
    const stored = rows();
    const markerDetail = bed.db.all<{ detail: string }>("SELECT detail FROM audit WHERE kind = 'audit'");
    expect(markerDetail.map((row) => JSON.parse(row.detail))).toEqual([{ budget: "platform" }]);
    expect(stored.filter((row) => row.reason === AUDIT_RATE_LIMIT_REASON)).toEqual([
      { kind: "audit", reason: AUDIT_RATE_LIMIT_REASON, decision: "info" },
    ]);
    expect(stored.filter((row) => row.kind === "policy")).toHaveLength(120);
    call("ok2", "agent.notify", { text: "again" });
    expect(rows()).toHaveLength(121);
    expect(bed.lines.filter((line) => line.msg === "audit_rows_dropped")).toMatchObject([
      { sessionId: "s1", dropped: 1, budget: "platform" },
    ]);
  });

  it("logs the count when the window ends and runs the op in the next window with its allow row", async () => {
    const { handler, call, rows } = open();
    for (let i = 0; i < 125; i++) call(`f${i}`, "lane.note", { note: "x" });
    await bed.clock.advance(60_000);
    call("ok1", "agent.notify", { text: "hello" });
    await bed.clock.advance(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rows().at(-1)).toEqual({ kind: "policy", reason: "ok", decision: "allow" });
    expect(bed.lines.filter((line) => line.msg === "audit_rows_dropped")).toMatchObject([
      { dropped: 1, budget: "platform" },
      { dropped: 5, budget: "platform" },
    ]);
  });
});
