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
});
