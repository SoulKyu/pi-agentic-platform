import { PLATFORM_OPS, PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { DENYLIST_MODEL_REASON } from "./denylist.ts";
import { PREVIEW_START_REASON } from "./preview-start-plan.ts";
import { READ_ONLY_REASON } from "./reasons.ts";
import { PLATFORM_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const tools = Object.fromEntries(
  Object.values(PLATFORM_OPS).map((spec) => [spec.tool, { path: PLATFORM_SOURCE }]),
);
const rulesIn = (approvalMode: PolicyRules["approvalMode"], extra: object = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode,
    sandbox: { required: true, network: true },
    ...extra,
  });
const ASK = { outcome: "ask", reason: "asks", answers: ["deny", "once"], grantable: false } as const;
const START = { name: "site", command: "python3 -m http.server 8000", port: 8000 };

describe("preview_start is judged as the shell would be (UX2-R26)", () => {
  it("read-only blocks it, tainted or not, and raises no card", async () => {
    for (const taint of [false, true]) {
      const h = bed.harness({ rules: () => rulesIn("read-only"), tools, taint });
      expect(await h.run("preview_start", START)).toEqual({ block: true, reason: READ_ONLY_REASON });
      expect(h.asks).toHaveLength(0);
    }
  });

  it("supervised asks Deny or Allow once, not grantable, and a session grant never skips it", async () => {
    for (const taint of [false, true]) {
      const h = bed.harness({
        rules: () => rulesIn("supervised"),
        tools,
        taint,
        answers: [
          { answer: "session", closed: false },
          { answer: "once", closed: false },
        ],
      });
      await h.run("preview_start", START, "c1");
      await h.run("preview_start", START, "c2");
      expect(h.asks).toHaveLength(2);
      expect(h.asks[0]).toMatchObject({
        title: "pap: start a preview?",
        answers: ["deny", "once"],
        tool: "preview_start",
      });
      expect(h.asks[0]?.message).toContain(PREVIEW_START_REASON);
      expect(h.asks[0]?.message).toContain(START.command);
    }
  });

  it.each(["auto-accept-edits", "full-access"] as const)("%s lets it run, tainted or not", async (mode) => {
    for (const taint of [false, true]) {
      const h = bed.harness({ rules: () => rulesIn(mode), tools, taint });
      expect(await h.run("preview_start", START)).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });

  it("the read-only preset asks, even in full-access", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access", { readOnlyPreset: true }), tools });
    await h.run("preview_start", START);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ answers: ["deny", "once"] });
  });

  it("a denylisted command in preview_start is blocked by stage 01, in full-access", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access"), tools });
    expect(await h.run("preview_start", { ...START, command: "rm -rf /" })).toEqual({
      block: true,
      reason: DENYLIST_MODEL_REASON,
    });
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: expect.stringMatching(/^denied: /) });
  });

  it("preview_stop stays the generic platform allow, even in read-only", async () => {
    for (const mode of ["read-only", "supervised", "auto-accept-edits", "full-access"] as const) {
      const h = bed.harness({ rules: () => rulesIn(mode), tools, taint: true });
      expect(await h.run("preview_stop", { name: "site" })).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });
});

// Equivalent mutants, by design (UX2-R26): the matrix asked tainted (`edit` is not exfiltration-capable) and `grantable: true`
// (no answer on this card records a grant) change no observable verdict.
describe("MQ6: the session moved to read-only while the card was open (red team I8)", () => {
  const moving = () => {
    let rules = rulesIn("supervised");
    let version = 0;
    return {
      rules: () => rules,
      rulesVersion: () => version,
      tools,
      ask: async () => {
        rules = rulesIn("read-only");
        version++;
        return { answer: "once" as const, closed: false };
      },
    };
  };

  it("a supervised preview_start answered Allow once after the move to read-only is refused", async () => {
    const h = bed.harness(moving());
    expect(await h.run("preview_start", START)).toEqual({ block: true, reason: READ_ONLY_REASON });
    expect(h.asks).toHaveLength(1);
    expect(h.entries.at(-1)).toMatchObject({
      decision: "block",
      reason: "policy changed while the question was open: read-only",
    });
  });

  it("an answered preview_stop still runs after the move: it runs nothing", async () => {
    const h = bed.harness({ ...moving(), taint: true, stages: { approval: async () => ASK } });
    expect(await h.run("preview_stop", { name: "site" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
  });
});
