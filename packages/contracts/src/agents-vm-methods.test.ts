import { describe, expect, it } from "vitest";
import { agentsVmMethods } from "./agents-vm-methods.ts";
import { methods } from "./methods.ts";
import { METHOD_IDEMPOTENT } from "./methods-idempotent.ts";

describe("agentsVmMethods", () => {
  it("declares the permissions", () => {
    expect(agentsVmMethods["agents.vm.setClaudeToken"].permission).toBe("settings:operate");
    expect(agentsVmMethods["agents.vm.clearClaudeToken"].permission).toBe("settings:operate");
    expect(agentsVmMethods["agents.vmStatus"].permission).toBe("agents:read");
    expect(agentsVmMethods["agents.purgeTrash"].permission).toBe("agents:admin");
  });

  // M8. The service throws command_failed when pap-vmd's purge fails (trash-purge.ts); a code not declared is not mapped for clients.
  it("declares every error agents.purgeTrash can throw", () => {
    expect(agentsVmMethods["agents.purgeTrash"].errors).toEqual(
      expect.arrayContaining(["step_up_required", "not_found", "sandbox_unavailable", "command_failed"]),
    );
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

  it("lists the owner's trashed agents with a read (J1b: the entry that outlives the delete toast)", () => {
    const def = agentsVmMethods["agents.trash"];
    expect(def.permission).toBe("agents:read");
    expect(def.idempotent).toBe(true);
    expect(METHOD_IDEMPOTENT["agents.trash"]).toBe(true);
    expect(def.params.safeParse({}).success).toBe(true);
    expect(def.params.safeParse({ all: true }).success).toBe(false);
    const entry = { agentId: "atlas-0001", name: "Atlas", deletedAt: 1 };
    expect(def.result.safeParse({ agents: [entry] }).success).toBe(true);
    expect(def.result.safeParse({ agents: [{ ...entry, path: "/x" }] }).success).toBe(false);
    expect(def.result.safeParse({ agents: Array.from({ length: 33 }, () => entry) }).success).toBe(false);
  });

  it("answers the VM status", () => {
    const result = agentsVmMethods["agents.vmStatus"].result;
    const view = {
      usable: true,
      reason: null,
      vmdVersion: "1.0.0",
      claudeToken: "set",
      agents: [{ id: "helper-1a2b", phase: "running" }],
    };
    expect(result.safeParse(view).success).toBe(true);
    // AVM-E33: the host's ceilings for one agent; absent or null in host mode.
    const host = { memoryMb: 7680, cpus: 4, diskMb: 20480 };
    expect(result.safeParse({ ...view, host }).success).toBe(true);
    expect(result.safeParse({ ...view, host: { ...host, diskMb: null } }).success).toBe(true);
    expect(result.safeParse({ ...view, host: null }).success).toBe(true);
    expect(result.safeParse({ ...view, host: { ...host, cpus: 0 } }).success).toBe(false);
    expect(result.safeParse({ ...view, host: { ...host, path: "/x" } }).success).toBe(false);
    expect(result.safeParse({ ...view, runtime: "vm" }).success).toBe(false);
    // AVM-E53: no agent is migrated, so the view has no such field (the entry is strict).
    expect(
      result.safeParse({ ...view, agents: [{ id: "helper-1a2b", phase: "running", migrated: false }] })
        .success,
    ).toBe(false);
    expect(result.safeParse({ ...view, agents: [{ id: "helper-1a2b", phase: "gone" }] }).success).toBe(false);
    const many = Array.from({ length: 33 }, () => ({ id: "helper-1a2b", phase: "stopped" }));
    expect(result.safeParse({ ...view, agents: many }).success).toBe(false);
  });
});
