import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed, idleTaint, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";
import { MIXED_MESSAGE } from "./message-mix.ts";
import { SANDBOX_SOURCE } from "./tool-kind.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let home: string;
beforeEach(async () => {
  bed = await createPipelineBed();
  home = join(bed.papHome, "agents", "atlas-1a2b");
  await mkdir(home, { recursive: true });
});
afterEach(() => bed.dispose());

/** The real policy extension on a fake Pi: the handlers it registers, called the way Pi calls them. */
async function wire() {
  const handlers = new Map<string, Handler>();
  const rules = PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "auto-accept-edits",
    agentHome: home,
    sandbox: { required: true, network: false },
  });
  const extension = createPapPolicyExtension({
    ...bed.config,
    taint: idleTaint(),
    secrets: NO_SECRETS,
    rules: () => rules,
    rulesVersion: () => 0,
    audit: () => {},
    ask: async () => ({ answer: "deny", closed: false }),
    sandbox: { network: false },
  });
  await extension.factory({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [
      { name: "bash", sourceInfo: { path: SANDBOX_SOURCE } },
      { name: "write", sourceInfo: { path: "builtin:write" } },
    ],
    getActiveTools: () => ["bash", "write"],
  } as unknown as ExtensionAPI);
  let id = 0;
  const call = (toolName: string, input: object) =>
    handlers.get("tool_call")?.(
      { toolCallId: `c${++id}`, toolName, input },
      { hasUI: false, cwd: home, signal: undefined },
    ) as Promise<{ block?: boolean; reason?: string } | undefined>;
  const bash = () => call("bash", { command: "echo hi > a.txt" });
  const write = () => call("write", { path: join(home, "w.txt"), content: "x" });
  const fire = (name: string, event: object = {}) => void handlers.get(name)?.(event, {});
  return { bash, write, fire };
}

describe("when the per-message marker restarts (W5-R11)", () => {
  it("at the assistant's message_end, not at a tool result or a user message", async () => {
    const { bash, write, fire } = await wire();
    expect(await bash()).toBeUndefined();
    expect(await write()).toMatchObject({ block: true });
    fire("message_end", { message: { role: "toolResult" } });
    fire("message_end", { message: { role: "user" } });
    expect(await write()).toMatchObject({ block: true });
    fire("message_end", { message: { role: "assistant" } });
    expect(await write()).toBeUndefined();
  });

  it("at agent_start", async () => {
    const { bash, write, fire } = await wire();
    expect(await write()).toBeUndefined();
    const refused = await bash();
    expect(refused).toMatchObject({ block: true });
    expect(refused?.reason).toContain(MIXED_MESSAGE);
    fire("agent_start");
    expect(await bash()).toBeUndefined();
  });
});
