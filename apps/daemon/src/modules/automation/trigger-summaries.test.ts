import { describe, expect, it } from "vitest";
import { summaryOf } from "./trigger-summaries.ts";
import type { TriggerRecord } from "./triggers.ts";

const record = (agentId: string | null) =>
  ({
    id: "g1",
    name: "n",
    enabled: true,
    sourceType: "manual",
    projectId: null,
    nextFireAt: null,
    input: {},
    agentId,
  }) as unknown as TriggerRecord;

describe("summaryOf: the agent of a trigger (M11R128)", () => {
  it("carries the agent id of an agent trigger", () => {
    expect(summaryOf(record("atlas-1a2b"), "/nowhere").agentId).toBe("atlas-1a2b");
  });

  it("carries null for a project trigger", () => {
    expect(summaryOf(record(null), "/nowhere").agentId).toBeNull();
  });
});
