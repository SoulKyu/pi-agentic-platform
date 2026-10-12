import type { CallAuditEntry } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { AuditNotSent, auditSinkOf } from "./audit-sink.ts";
import { FAIL_CLOSED_REASON } from "./pipeline.ts";

const CALL_ENTRY: CallAuditEntry = {
  kind: "call",
  toolCallId: "c1",
  tool: "read",
  category: "read",
  decision: "allow",
  stages: [],
  args: "{}",
};

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
});
afterEach(async () => {
  await bed.dispose();
});

describe("auditSinkOf", () => {
  it("hands the entry to the channel, and throws when the channel drops it (M5R114)", () => {
    const sent: unknown[] = [];
    auditSinkOf((record) => (sent.push(record), true))(CALL_ENTRY);
    expect(sent).toEqual([{ type: "audit", entry: CALL_ENTRY }]);
    expect(() => auditSinkOf(() => false)(CALL_ENTRY)).toThrow(AuditNotSent);
  });

  it("blocks the call when its audit record cannot leave the worker", async () => {
    const h = bed.harness({ audit: auditSinkOf(() => false) });
    expect(await h.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  });
});
