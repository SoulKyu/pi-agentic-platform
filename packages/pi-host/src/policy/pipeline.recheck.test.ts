import { type PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALLOW_ASK, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { type CallFacts, FAIL_CLOSED_REASON, READ_ONLY_REASON } from "./pipeline.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const tighten = (patch: Partial<PolicyRules>) => {
  let rules: PolicyRules = interactiveRules;
  let version = 0;
  return {
    rules: () => rules,
    rulesVersion: () => version,
    ask: async () => {
      rules = { ...rules, ...patch };
      version++;
      return { answer: "once" as const, closed: false };
    },
  };
};

it("blocks an answered call when the session became read-only while its question was open, and never asks again", async () => {
  const h = bed.harness({ ...tighten({ approvalMode: "read-only" }), stages: ALLOW_ASK });
  expect(await h.run("bash", { command: "make" })).toEqual({ block: true, reason: READ_ONLY_REASON });
  expect(h.asks).toHaveLength(1);
  expect(h.entries.at(-1)).toMatchObject({
    decision: "block",
    reason: "policy changed while the question was open: read-only",
  });
});

it("blocks an answered call that a new denylist stage refuses", async () => {
  const refuse = (call: CallFacts) =>
    call.rules.denylist.length > 0
      ? { outcome: "block" as const, reason: "denied: make*", modelReason: "blocked-command list" }
      : { outcome: "skip" as const, reason: "not in force" };
  const h = bed.harness({ ...tighten({ denylist: ["make*"] }), stages: { ...ALLOW_ASK, denylist: refuse } });
  expect(await h.run("bash", { command: "make" })).toEqual({ block: true, reason: "blocked-command list" });
  expect(h.entries.at(-1)).toMatchObject({
    decision: "block",
    reason: "policy changed while the question was open: denied: make*",
  });
});

it("blocks an answered call that a new egress stage refuses", async () => {
  const refuse = (call: CallFacts) =>
    call.rules.allowHosts !== null
      ? { outcome: "block" as const, reason: "host not allowed", modelReason: "egress list" }
      : { outcome: "skip" as const, reason: "no egress list" };
  const h = bed.harness({ ...tighten({ allowHosts: [] }), stages: { ...ALLOW_ASK, egress: refuse } });
  expect(await h.run("bash", { command: "make" })).toEqual({ block: true, reason: "egress list" });
});

it("lets an answered call run when the rules moved but still allow it", async () => {
  const h = bed.harness({ ...tighten({ alwaysAllow: [] }), stages: ALLOW_ASK });
  expect(await h.run("bash", { command: "make" })).toBeUndefined();
  expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
});

it("blocks an answered call when the rules became unreadable while its question was open", async () => {
  let rules: PolicyRules | null = interactiveRules;
  let version = 0;
  const h = bed.harness({
    rules: () => rules,
    rulesVersion: () => version,
    ask: async () => ((rules = null), version++, { answer: "once", closed: false }),
    stages: ALLOW_ASK,
  });
  expect(await h.run("bash", { command: "make" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
});

it("does not re-check an answered call when the rules did not move", async () => {
  const h = bed.harness({
    rules: () => ({ ...interactiveRules, approvalMode: "read-only" }),
    stages: ALLOW_ASK,
  });
  expect(await h.run("bash", { command: "make" })).toBeUndefined();
});
