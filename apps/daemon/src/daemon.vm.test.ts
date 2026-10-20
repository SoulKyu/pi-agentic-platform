import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBackend } from "./modules/agent-vm/index.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf8");

describe("the daemon's agents VM wiring (T8a, fail closed)", () => {
  // Mutants: each of the three lines removed from daemon.ts. The boot below stops without `vm: agentsVm` (setAgentPorts
  // refuses), and these assertions stop the other two, which would leave the sessions module in host mode silently.
  it("composes the VM before the sessions module and hands it to the sessions and to M11", () => {
    const composed = source.indexOf("composeAgentsVm(");
    expect(composed).toBeGreaterThan(0);
    expect(composed).toBeLessThan(source.indexOf("createSessionsModule("));
    expect(composed).toBeLessThan(source.indexOf("startServer("));
    expect(source).toContain("vmLaunch: agentsVm?.launch");
    expect(source).toContain("vm: agentsVm");
  });

  const started: TestDaemon[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  });
  const backend = (): AgentRuntimeBackend => ({
    start: vi.fn(async () => ({ address: "127.0.0.1" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  });

  it("boots in vm mode with a backend, and stops the VMs again at stop", async () => {
    const fake = backend();
    const daemon = await startTestDaemon(
      { steps: [] },
      {
        config: { agentsRuntime: "vm", testAgentRuntime: "process" },
        deps: { agentsVm: { backend: () => fake, relay: "off" } },
      },
    );
    started.push(daemon);
    expect(fake.list).toHaveBeenCalledTimes(1);
    await daemon.stop();
    started.length = 0;
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  // Without the test switch the backend is Kata, through pap-vmd's socket (a path that is not there, never the real one).
  it("refuses to boot in vm mode with no pap-vmd to start a VM", async () => {
    await expect(
      startTestDaemon(
        { steps: [] },
        {
          config: { agentsRuntime: "vm", testAgentRuntime: null },
          deps: { agentsVm: { kata: { socket: "/nonexistent/pap-vm/vmd.sock" } } },
        },
      ),
    ).rejects.toThrow(/pap-vmd/);
  });
});
