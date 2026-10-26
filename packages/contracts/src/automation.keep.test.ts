import { describe, expect, it } from "vitest";
import { TriggerInput } from "./index.ts";

const AGENT = "atlas-1a2b";
const parse = (source: unknown, agent: unknown) =>
  TriggerInput.safeParse({
    name: "Pulse",
    source,
    execution: { agent },
    prompt: "Look and report.",
  });

describe("TriggerAgent.keep (K2)", () => {
  it("accepts keep with an isolated target and keeps the flag", () => {
    const parsed = parse({ type: "manual" }, { agentId: AGENT, target: "isolated", keep: true });
    expect(parsed.success && parsed.data.execution.agent).toEqual({
      agentId: AGENT,
      target: "isolated",
      keep: true,
    });
  });

  it("reads an absent keep as off, and an explicit false is accepted", () => {
    const absent = parse({ type: "manual" }, { agentId: AGENT, target: "isolated" });
    expect(absent.success && absent.data.execution.agent?.keep).toBeUndefined();
    expect(parse({ type: "manual" }, { agentId: AGENT, target: "isolated", keep: false }).success).toBe(true);
  });

  it("refuses keep with a thread target (the thread has its own disk)", () => {
    const parsed = parse({ type: "manual" }, { agentId: AGENT, target: "thread", keep: true });
    expect(parsed.success).toBe(false);
    expect(parse({ type: "manual" }, { agentId: AGENT, target: "thread", keep: false }).success).toBe(true);
  });
});
