import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

const withAlways: PolicyRules = {
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [{ tool: "bash", key: "d".repeat(64) }],
};

describe("dispatch", () => {
  it("drops the always rules when a policy update is malformed, and says so (M2-RT-17)", () => {
    const sent: Array<Record<string, unknown>> = [];
    let rules = withAlways;
    const dispatch = createDispatch({
      session: {} as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      rules: () => rules,
      setRules: (next) => {
        rules = next;
      },
    });
    dispatch({ type: "policy_update", rules: { profile: "interactive", approvalMode: "yolo" } });
    expect(rules).toEqual({ ...withAlways, alwaysAllow: [] });
    expect(sent).toEqual([expect.objectContaining({ type: "extension_error", event: "policy_update" })]);
    dispatch({ type: "policy_update", rules: withAlways });
    expect(rules).toEqual(withAlways);
  });
});
