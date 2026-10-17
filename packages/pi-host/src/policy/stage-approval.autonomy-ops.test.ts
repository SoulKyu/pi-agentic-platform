import { PLATFORM_OPS, PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { PLATFORM_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const tools = Object.fromEntries(
  Object.values(PLATFORM_OPS).map((spec) => [spec.tool, { path: PLATFORM_SOURCE }]),
);
const rulesOf = (extra: object) =>
  PolicyRules.parse({ profile: "agent-thread", approvalMode: "supervised", ...extra });
const AUTONOMY = { autonomy: { hosts: [] } };
const REMIND = { when: "in 2 hours", note: "check" };
const DELEGATE = { agent: "Scout", task: "look" };

describe("tainted agent_remind and agent_delegate with trusted autonomy (M11R240)", () => {
  it("runs both without a card, with the reason trusted autonomy", async () => {
    for (const [tool, input] of [
      ["agent_remind", REMIND],
      ["agent_delegate", DELEGATE],
    ] as const) {
      const h = bed.harness({ rules: () => rulesOf(AUTONOMY), tools, taint: true });
      expect(await h.run(tool, input)).toBeUndefined();
      expect(h.asks).toHaveLength(0);
      expect(h.entries.at(-1)).toMatchObject({
        decision: "allow",
        reason: "trusted autonomy",
        stages: expect.arrayContaining([{ stage: "03", outcome: "allow", reason: "trusted autonomy" }]),
      });
    }
  });

  it("asks Deny / Allow once without autonomy", async () => {
    const h = bed.harness({ rules: () => rulesOf({}), tools, taint: true });
    await h.run("agent_remind", REMIND);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("gives an isolated task with a forged autonomy no platform path", async () => {
    const h = bed.harness({
      rules: () => rulesOf({ profile: "isolated-task", ...AUTONOMY }),
      tools,
      taint: true,
    });
    const result = await h.run("agent_remind", REMIND);
    expect(result).toMatchObject({ block: true });
    expect(h.entries.at(-1)).not.toMatchObject({ reason: "trusted autonomy" });
  });

  it("gives an interactive session with a forged autonomy no relaxation: it still asks", async () => {
    const h = bed.harness({
      rules: () => rulesOf({ profile: "interactive", ...AUTONOMY }),
      tools,
      taint: true,
    });
    await h.run("agent_remind", REMIND);
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).not.toMatchObject({ reason: "trusted autonomy" });
  });

  it("allows an untainted call as before", async () => {
    const h = bed.harness({ rules: () => rulesOf(AUTONOMY), tools });
    expect(await h.run("agent_remind", REMIND)).toBeUndefined();
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow", reason: "pap platform call" });
  });
});
