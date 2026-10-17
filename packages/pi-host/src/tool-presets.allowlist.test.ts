import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { applyPreset, pinToolAllowlist, withPreset } from "./tool-presets.ts";

const REGISTERED = ["read", "bash", "edit", "write", "grep", "mcp__fix__lookup", "codemode"];

function fakeSession(active: string[]) {
  let names = [...active];
  const session = {
    getActiveToolNames: () => [...names],
    getAllTools: () => REGISTERED.map((name) => ({ name, sourceInfo: { path: `builtin:${name}` } })),
    setActiveToolsByName: (next: string[]) => {
      names = [...next];
    },
    settingsManager: { getDefaultTools: () => undefined },
  };
  return { session: session as unknown as AgentSession, active: () => names };
}

describe("the pinned tool allowlist and the active tool set (M10R29)", () => {
  it("makes the allowlisted registered names the active ones, at every re-apply", () => {
    const { session, active } = fakeSession(REGISTERED);
    pinToolAllowlist(session, ["read", "mcp__fix__lookup", "not_registered"]);
    applyPreset(session, "full");
    expect(active()).toEqual(["read", "mcp__fix__lookup"]);
    applyPreset(session, "full");
    expect(active()).toEqual(["read", "mcp__fix__lookup"]);
  });

  it("leaves the preset alone when no list is pinned", () => {
    const { session, active } = fakeSession(REGISTERED);
    applyPreset(session, "read-only");
    expect(active()).toContain("codemode");
    expect(active()).not.toContain("bash");
  });
});

describe("withPreset: the pinned allowlist reaches the rules (M10R28)", () => {
  const rules = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });

  it("a rules update cannot lift or widen the pinned list, and can narrow it", () => {
    expect(withPreset(rules, "read-only", ["read"])?.toolAllowlist).toEqual(["read"]);
    expect(
      withPreset({ ...rules, toolAllowlist: ["read", "bash"] }, "full", ["read"])?.toolAllowlist,
    ).toEqual(["read"]);
    expect(withPreset({ ...rules, toolAllowlist: [] }, "full", ["read"])?.toolAllowlist).toEqual([]);
  });

  it("follows the rules when nothing is pinned", () => {
    expect(withPreset(rules, "full")?.toolAllowlist).toBeNull();
    expect(withPreset({ ...rules, toolAllowlist: ["read"] }, "full")?.toolAllowlist).toEqual(["read"]);
  });
});
