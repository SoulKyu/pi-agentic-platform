import { afterEach, describe, expect, it, vi } from "vitest";
import { composeAgentsVm, type AgentsVm, type AgentsVmCore } from "./compose-agents-vm.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import type { AgentRuntimeBackend } from "./modules/agent-vm/index.ts";
import type { SessionRow } from "./modules/sessions/index.ts";
import { sharesAllProviders } from "./testing/shares-all.ts";

/* M14 RT-03, chokepoint 2: the launch gate, wired to the late binding, refuses a disabled owner's box. */
const ID = "atlas-1a2b";
const core = (): AgentsVmCore => ({
  config: {
    home: "/pap-home",
    agentsRuntimeSet: false,
    dev: false,
    devVmd: false,
    agentsMemoryMaxMb: 8192,
    testAgentRuntime: "process",
    testVmdSocket: null,
    testProviderScript: "/script.json",
    workerIdleMs: 0,
    minFreeDiskMb: 0,
    piHostEntry: "/x/pi-host/src/main.ts",
    piHostExecArgv: [],
    piAgentDir: "/pi-agent",
  },
  clock: createFakeClock(),
  logger: silentLogger,
  env: {},
  readOnly: false,
  claudeToken: {
    get: () => null,
    read: () => ({ state: "missing" as const }),
    status: () => "missing",
    set: () => {},
    clear: () => {},
    onChange: () => () => {},
    migrateLegacy: () => {},
  },
});
const idle = (): AgentRuntimeBackend => ({
  start: vi.fn(async () => ({ address: "127.0.0.1" })),
  stop: vi.fn(async () => {}),
  list: vi.fn(async () => []),
});

const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
});

describe("the launch gate of a disabled owner", () => {
  it("refuses account_disabled for the box gate and for a session launch, until the account is enabled", async () => {
    const backend = idle();
    const vm = (await composeAgentsVm(core(), closers, {
      relay: "off",
      backend: () => backend,
    })) as AgentsVm;
    // Nothing restores or boots a box while the composition is built, so the fail-closed gate refuses no boot (M14 J1):
    // every start is on demand, after `bindLate`.
    expect(backend.start).not.toHaveBeenCalled();
    const box = { kind: "agent", id: ID } as const;
    // Before the late binding nothing says whose the box is: the gate fails closed (M14 J1).
    await expect(vm.boxStack.gate(box)).rejects.toMatchObject({ code: "sandbox_unavailable" });
    let disabled = true;
    vm.bindLate({
      sessions: { mirror: { notice: () => {}, taint: () => {} }, kindOf: () => ({ agentId: ID }) },
      providers: sharesAllProviders,
      memberLine: { over: () => false, disabled: () => disabled },
      pi: {
        models: {
          available: async () => ({ models: [], providers: [], origin: "signed-in", truncated: false }),
          onChanged: () => {},
        },
      },
      agents: { ownerOf: () => "u1", get: () => null, onChange: () => () => {} },
      runs: { port: { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
      automation: { agentTasks: { overBudget: () => false, ownerOverBudget: () => false } },
    } as never);
    const row = { id: "s1", ownerId: "u1", agentId: ID, agentRole: "thread" } as SessionRow;
    await expect(vm.boxStack.gate(box)).rejects.toMatchObject({ code: "account_disabled" });
    await expect(vm.launch.spawn(row, {} as never, {} as never)).rejects.toMatchObject({
      code: "account_disabled",
    });
    disabled = false;
    await expect(vm.boxStack.gate(box)).resolves.toBeUndefined();
  });
});
