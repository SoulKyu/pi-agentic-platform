import { ApprovalRequestRecord } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

describe("the question names its call", () => {
  it("carries the tool call id, so the daemon can tell who answered which call", async () => {
    const h = bed.harness({ answers: [{ answer: "once", closed: false }] });
    await h.run("bash", { command: "ls" }, "call-77");
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ tool: "bash", toolCallId: "call-77" });
    expect(h.entries.at(-1)).toMatchObject({ toolCallId: "call-77", decision: "approved" });
  });

  it("sends the clipped id for a 300-character one, so the contract accepts the question", async () => {
    const h = bed.harness({ answers: [{ answer: "once", closed: false }] });
    await h.run("bash", { command: "ls" }, "x".repeat(300));
    const sent = (h.asks[0] as { toolCallId?: string }).toolCallId ?? "";
    expect(sent.length).toBeLessThanOrEqual(256);
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", toolCallId: sent });
    expect(ApprovalRequestRecord.safeParse({ type: "approval_request", id: "i", ...h.asks[0] }).success).toBe(
      true,
    );
  });
});
