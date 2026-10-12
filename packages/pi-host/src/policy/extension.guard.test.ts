import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { idleTaint, interactiveRules, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";
import { GUARD_MODEL_REASON } from "./run-guard.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

async function load() {
  const handlers = new Map<string, Handler>();
  const extension = createPapPolicyExtension({
    taint: idleTaint(),
    rules: () => ({ ...interactiveRules, guard: { identicalCalls: 100, toolCalls: 150, turns: 1 } }),
    rulesVersion: () => 0,
    audit: () => {},
    secrets: NO_SECRETS,
    agentDir: "/agent",
    papHome: "/pap",
    ask: async () => ({ answer: "once", closed: false }),
  });
  await extension.factory({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [{ name: "read", sourceInfo: { path: "builtin:read" } }],
    getActiveTools: () => ["read"],
  } as unknown as ExtensionAPI);
  const fire = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event, { hasUI: false, cwd: "/work" });
  const read = (id: string) =>
    fire("tool_call", { toolCallId: id, toolName: "read", input: { path: "a" } }) as Promise<unknown>;
  return { fire, read };
}

const assistant = { message: { role: "assistant" } };

describe("pap-policy run guard hooks", () => {
  it("counts assistant message ends as turns and restarts the count at agent_start", async () => {
    const { fire, read } = await load();
    fire("agent_start");
    expect(await read("c1")).toBeUndefined();
    fire("message_end", { message: { role: "user" } });
    fire("message_end", { message: { role: "toolResult" } });
    fire("message_end", assistant);
    expect(await read("c2")).toBeUndefined();
    fire("message_end", assistant);
    expect(await read("c3")).toEqual({ block: true, reason: GUARD_MODEL_REASON });
    fire("agent_start");
    expect(await read("c4")).toBeUndefined();
  });

  it("lets a malformed message_end go by without raising into the run", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { fire } = await load();
    try {
      expect(() => fire("message_end", {})).not.toThrow();
      expect(write).toHaveBeenCalledWith("pi-host: run guard failed (TypeError)\n");
    } finally {
      write.mockRestore();
    }
  });
});
