import { describe, expect, it } from "vitest";
import { agentsVmMethods } from "./agents-vm-methods.ts";
import { methods } from "./methods.ts";
import { METHOD_IDEMPOTENT } from "./methods-idempotent.ts";

describe("agentsVmMethods", () => {
  it("declares the permissions", () => {
    expect(agentsVmMethods["agents.vm.setClaudeToken"].permission).toBe("pi:admin");
    expect(agentsVmMethods["agents.vm.clearClaudeToken"].permission).toBe("pi:admin");
    expect(agentsVmMethods["agents.vmStatus"].permission).toBe("agents:read");
    expect(agentsVmMethods["agents.purgeTrash"].permission).toBe("agents:admin");
  });

  it("asks for the password step-up on the token and the purge", () => {
    for (const name of [
      "agents.vm.setClaudeToken",
      "agents.vm.clearClaudeToken",
      "agents.purgeTrash",
    ] as const) {
      expect(agentsVmMethods[name].errors, name).toContain("step_up_required");
    }
    expect(agentsVmMethods["agents.vm.setClaudeToken"].errors).toContain("sandbox_unavailable");
  });

  it("keeps the token out of the receipt: the only param is the secret, so none is hashed", () => {
    expect(agentsVmMethods["agents.vm.setClaudeToken"].sensitiveParams).toEqual([]);
    expect(agentsVmMethods["agents.vm.setClaudeToken"].params.safeParse({ token: "" }).success).toBe(false);
    expect(
      agentsVmMethods["agents.vm.setClaudeToken"].params.safeParse({ token: "x".repeat(513) }).success,
    ).toBe(false);
    expect(agentsVmMethods["agents.vm.setClaudeToken"].params.safeParse({ token: "t" }).success).toBe(true);
  });

  it("trims the token and refuses a control character (header injection)", () => {
    const params = agentsVmMethods["agents.vm.setClaudeToken"].params;
    expect(params.safeParse({ token: "abc\r\nX-Evil: 1" }).success).toBe(false);
    expect(params.safeParse({ token: "   " }).success).toBe(false);
    expect(params.parse({ token: "  sk-ant-oat01-x \n" }).token).toBe("sk-ant-oat01-x");
  });

  it("is in the catalogue, as a mutation", () => {
    for (const name of [
      "agents.vm.setClaudeToken",
      "agents.vm.clearClaudeToken",
      "agents.purgeTrash",
    ] as const) {
      expect(methods[name].idempotent, name).toBe(false);
      expect(METHOD_IDEMPOTENT[name], name).toBe(false);
    }
    expect(methods["agents.vmStatus"].idempotent).toBe(true);
    expect(METHOD_IDEMPOTENT["agents.vmStatus"]).toBe(true);
  });

  it("answers the VM status", () => {
    const result = agentsVmMethods["agents.vmStatus"].result;
    const view = {
      runtime: "vm",
      usable: true,
      reason: null,
      vmdVersion: "1.0.0",
      claudeToken: "set",
      agents: [{ id: "helper-1a2b", phase: "running", migrated: false }],
    };
    expect(result.safeParse(view).success).toBe(true);
    expect(result.safeParse({ ...view, runtime: "kata" }).success).toBe(false);
    expect(
      result.safeParse({ ...view, agents: [{ id: "helper-1a2b", phase: "gone", migrated: false }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 33 }, () => ({ id: "helper-1a2b", phase: "stopped", migrated: true }));
    expect(result.safeParse({ ...view, agents: many }).success).toBe(false);
  });
});
