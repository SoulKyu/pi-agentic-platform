import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import { applyPreset } from "./tool-presets.ts";
import type { UiBridge } from "./ui-bridge.ts";

function sessionWith(active: string[]) {
  let names = [...active];
  const session = {
    isIdle: true,
    model: undefined,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off"],
    getActiveToolNames: () => [...names],
    setActiveToolsByName: (next: string[]) => void (names = [...next]),
    settingsManager: { getDefaultTools: () => undefined },
    // Pi restores the tools the branch had, bash included.
    navigateTree: async () => {
      names = [...names, "bash"];
      return { cancelled: false };
    },
    sessionManager: { getLeafId: () => "e7" },
  };
  return { session: session as unknown as AgentSession, active: () => names };
}

describe("navigate_tree puts the preset back (M7R75)", () => {
  it("restores the preset's tools after Pi restored the branch's, and tells the loadout", async () => {
    const { session, active } = sessionWith(["read", "bash", "edit", "write", "mcp__fix__lookup"]);
    applyPreset(session, "read-only");
    const sent: Array<{ type: string; loadout?: { tools: string[] } }> = [];
    const dispatch = createDispatch({
      papHome: "/pap",
      applyTaint: () => {},
      session,
      ipc: { send: (record: { type: string }) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
    });
    dispatch({ type: "navigate_tree", id: "n1", targetId: "e7" });
    await vi.waitFor(() => expect(sent.map((record) => record.type)).toEqual(["response", "loadout"]));
    expect(active()).not.toContain("bash");
    expect(active()).toContain("mcp__fix__lookup");
    expect(sent[1]?.loadout?.tools).not.toContain("bash");
  });
});
