import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idleTaint, interactiveRules, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension, type PolicyConfig } from "./extension.ts";

async function agentStartHandler(onAgentStart: PolicyConfig["onAgentStart"]) {
  const handlers = new Map<string, () => void>();
  const extension = createPapPolicyExtension({
    taint: idleTaint(),
    rules: () => interactiveRules,
    rulesVersion: () => 0,
    audit: () => {},
    secrets: NO_SECRETS,
    agentDir: "/agent",
    papHome: "/pap",
    ask: async () => ({ answer: "once", closed: false }),
    ...(onAgentStart ? { onAgentStart } : {}),
  });
  await extension.factory({
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    getAllTools: () => [],
    getActiveTools: () => ["read", "mcp__x__y"],
  } as unknown as ExtensionAPI);
  return handlers.get("agent_start");
}

afterEach(() => vi.restoreAllMocks());

describe("pap-policy agent_start", () => {
  it("hands the tools declared to the model to onAgentStart", async () => {
    const seen: string[][] = [];
    (await agentStartHandler((names) => seen.push(names)))?.();
    expect(seen).toEqual([["read", "mcp__x__y"]]);
  });

  it("logs a failing onAgentStart by class and lets the run go on", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const handler = await agentStartHandler(() => {
      throw new RangeError("secret detail");
    });
    expect(() => handler?.()).not.toThrow();
    expect(write).toHaveBeenCalledWith("pi-host: session entry failed (RangeError)\n");
  });
});
