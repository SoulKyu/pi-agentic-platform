import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostBed, isApproval, isCallAudit, toolText } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

const within = { timeout: 20_000 };

describe("pi-host worker: run guard", () => {
  it("asks on the 5th identical call of a run, and a deny ends it with the stage 04 line", async () => {
    mkdirSync(bed.cwd, { recursive: true });
    writeFileSync(join(bed.cwd, "loop.txt"), "again\n");
    const steps = Array.from({ length: 5 }, (_, i) => ({
      toolCalls: [{ name: "read", args: { path: "loop.txt" }, id: `call-${i + 1}` }],
    }));
    await bed.start({ steps: [...steps, { text: "done" }] });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ guard: "identical-calls", answers: ["deny", "once"], tool: "read" });
    expect(host.records.filter(isCallAudit)).toHaveLength(4);
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end" && r.isError === true);
    expect(toolText(end)).toContain("the run guard tripped");
    await vi.waitFor(() => expect(host.records.filter(isCallAudit)).toHaveLength(5), within);
    expect(host.records.filter(isCallAudit).at(-1)).toMatchObject({
      entry: {
        decision: "denied",
        stages: expect.arrayContaining([
          { stage: "04", outcome: "ask", reason: "the same call 5 times in a row" },
        ]),
      },
    });
  });
});
