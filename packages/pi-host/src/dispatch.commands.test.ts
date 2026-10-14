import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

it("answers get_commands from the session's registry, template list and skills", () => {
  const session = {
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [{ name: "t", description: "d", sourceInfo: { path: "/t.md" } }],
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
  } as unknown as AgentSession;
  const sent: unknown[] = [];
  const dispatch = createDispatch({
    papHome: "/pap",
    applyTaint: () => {},
    session,
    ipc: { send: (record: unknown) => void sent.push(record) } as unknown as Ipc,
    ui: {} as UiBridge,
    approvals: {} as Approvals,
    leafMayHaveMoved: () => {},
    setRules: () => {},
  });
  dispatch({ type: "get_commands", id: "g1" });
  expect(sent).toEqual([
    {
      type: "response",
      id: "g1",
      command: "get_commands",
      success: true,
      data: {
        commands: [{ name: "t", description: "d", source: "prompt", builtinMcp: false }],
        truncated: false,
      },
    },
  ]);
});
