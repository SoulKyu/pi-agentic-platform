import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PLATFORM_OPS, type PlatformError, type PlatformOp } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createPlatformTools, type PlatformPort } from "./platform-tools.ts";

// A worker that started with trusted autonomy sends the call; when the daemon refuses it `tainted`, the owner has turned
// autonomy off since (W5-R26), and the sentence says that instead of "the owner did not allow it".
const run = async (error: PlatformError, autonomous: boolean) => {
  const port: PlatformPort = { call: async () => ({ ok: false, error }) };
  const registered = new Map<string, ToolDefinition>();
  void createPlatformTools(["agent.delegate" as PlatformOp], port, () => autonomous).factory({
    registerTool: (def: ToolDefinition) => void registered.set(def.name, def),
  } as unknown as ExtensionAPI);
  const tool = registered.get(PLATFORM_OPS["agent.delegate"].tool) as ToolDefinition;
  return tool
    .execute("tc1", { agent: "Scout", task: "x" } as never, undefined, undefined, undefined as never)
    .then(
      () => "",
      (thrown: Error) => thrown.message,
    );
};

describe("the refusal of a tainted call from a worker that started with autonomy", () => {
  it("says autonomy was turned off", async () => {
    expect(await run("tainted", true)).toBe(
      "pap refused agent_delegate: trusted autonomy was turned off for this agent.",
    );
  });
  it("keeps the ordinary sentence without autonomy, and for any other code", async () => {
    expect(await run("tainted", false)).toContain("the owner did not allow it");
    expect(await run("forbidden", true)).toContain("this kind of session may not use it");
  });
});
