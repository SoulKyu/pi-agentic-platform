import { AgentInput, type PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { type AgentGateDeps, agentPrecheckSandbox } from "./agent-gate.ts";
import { captureLogger } from "./testing/helpers.ts";
import { VM_REFUSALS } from "./vm-rules.ts";

// R16 (RT-08): a trigger precheck of a VM agent is refused before anything is probed or opened.
function deps(vm: boolean) {
  const logs = captureLogger();
  let probed = 0;
  const value: AgentGateDeps = {
    papHome: "/nonexistent/pap",
    agentDir: "/nonexistent/pi",
    profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
    agentRunsInVm: () => vm,
    probe: {
      ensure: async () => {
        probed += 1;
        return { usable: true, path: "/usr/bin/bwrap" };
      },
    },
    logger: logs.logger,
  };
  return { value, probed: () => probed, logs };
}

describe("a precheck of a VM agent (R16)", () => {
  it("is sandbox_unavailable, logs the English sentence, and touches nothing", async () => {
    const { value, probed, logs } = deps(true);
    const error = await agentPrecheckSandbox(value, "u1", "atlas-1a2b").then(
      () => null,
      (caught: PapError) => caught,
    );
    expect(error?.code).toBe("sandbox_unavailable");
    expect(probed()).toBe(0);
    expect(JSON.stringify(logs.lines)).toContain(VM_REFUSALS.precheck);
  });
});
