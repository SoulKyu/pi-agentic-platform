import { describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import { vmRuleParts } from "./vm-rules.ts";

const layout = layoutOf("kata", "/p", { agentId: "a-1", taskKey: null });
const host = {
  profile: "agent-thread" as const,
  approvalMode: "full-access" as const,
  agentHome: "/p/agents/a-1",
  agentScratch: "/p/scratch",
  sandbox: { required: false, network: true },
  denylist: ["rm*"],
};

describe("vmRuleParts (R15)", () => {
  it("forces the VM shell whatever the profile says: sandbox off and network on both give required, no network", () => {
    expect(vmRuleParts(host, layout, false).sandbox).toEqual({ required: true, network: false });
    expect(
      vmRuleParts({ ...host, sandbox: { required: true, network: true } }, layout, false).sandbox,
    ).toEqual({
      required: true,
      network: false,
    });
  });
  it("puts the home in the layout and gives a thread no scratch", () => {
    expect(vmRuleParts(host, layout, false)).toMatchObject({ agentHome: layout.home, agentScratch: null });
  });
  it("gives an isolated task its VM's home as scratch", () => {
    expect(vmRuleParts(host, layout, true).agentScratch).toBe(layout.home);
  });
  it("keeps the other parts and no host path", () => {
    const out = vmRuleParts(host, layout, true);
    expect(out).toMatchObject({ profile: "agent-thread", approvalMode: "full-access", denylist: ["rm*"] });
    expect(JSON.stringify(out)).not.toContain("/p/");
  });
});
