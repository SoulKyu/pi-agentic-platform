import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const UNREADABLE = "true;".repeat(1001);
const TOO_COMPLEX = "command too complex for the policy check";

describe("lever B while a task runs (M10R152)", () => {
  it("asks Deny / Allow once in an attended session", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: UNREADABLE })).toBeUndefined();
    expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"]]);
  });

  it("blocks at stage 01 without a question when unattended", async () => {
    const h = bed.harness({ rules: () => ({ ...interactiveRules, unattended: true }) });
    expect(await h.run("bash", { command: UNREADABLE })).toEqual({ block: true, reason: TOO_COMPLEX });
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)?.stages[0]).toMatchObject({ stage: "01" });
  });
});
