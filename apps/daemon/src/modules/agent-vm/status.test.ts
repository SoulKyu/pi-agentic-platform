import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, VmStatusView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createClaudeTokenStore } from "./claude-token.ts";
import {
  assessStack,
  createHostStatus,
  createVmStatus,
  STACK_REASONS,
  STACK_TTL_MS,
  type VmStatusDeps,
} from "./status.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";

/*
 * Mutants (RT-43), each run for real in the T18 report:
 *  - M-version: the version comparison removed -> "a pap-vmd of another version" and the require case fail.
 *  - M-ruleset: `health.ruleset` ignored -> "a pap-vmd without its ruleset" fails.
 *  - M-bridge: `health.bridge` ignored -> "a pap-vmd without pap0" fails.
 *  - M-token: `claudeToken` answers the stored value -> the schema and the "never the value" cases fail.
 *  - M-ttl: the cache never expires / is never used -> the two TTL cases fail.
 *  - M-unchecked: `require` lets an unusable stack through -> the refusal case fails.
 *  - M-floor: the disk ceiling forgets PAP_MIN_FREE_DISK_MB -> the ceilings case fails.
 */
const PAP = "1.4.0";
const TOKEN = "sk-ant-oat01-OWNER-SETUP-TOKEN-0123456789";
let root: string;
let clock: FakeClock;
let vmd: FakeVmd;
let healthCalls = 0;
let answer: unknown;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-vm-status-"));
  clock = createFakeClock();
  vmd = createFakeVmd();
  healthCalls = 0;
  answer = { version: PAP, ruleset: true, bridge: true, stateFreeMb: 30_000 };
  vmd.handle("vmd.health", () => {
    healthCalls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(over: Partial<VmStatusDeps> = {}) {
  const { logger, lines } = captureLogger();
  const claudeToken = createClaudeTokenStore({ secretsDir: join(root, "secrets"), logger });
  const phases = new Map<string, "running" | "stopped">([["helper-1a2b", "running"]]);
  const status = createVmStatus({
    clock,
    logger,
    assess: () => assessStack(vmd, PAP),
    claudeToken,
    agentsOf: () => [{ id: "helper-1a2b" }, { id: "scout-9c8d" }],
    phaseOf: (id) => phases.get(id) ?? "stopped",
    host: () => ({ memoryCapMb: 8192, cores: 4 }),
    minFreeDiskMb: 1024,
    ...over,
  });
  return { status, claudeToken, lines };
}

describe("assessStack", () => {
  it("is usable when pap-vmd answers pap's version with its ruleset and bridge", async () => {
    await expect(assessStack(vmd, PAP)).resolves.toMatchObject({
      usable: true,
      reason: null,
      vmdVersion: PAP,
      health: { stateFreeMb: 30_000 },
    });
  });

  it("an unreachable pap-vmd is unusable with the setup sentence (M-unreachable)", async () => {
    vmd.failNext("vmd.health", "unavailable");
    const view = await assessStack(vmd, PAP);
    expect(view).toEqual({
      usable: false,
      reason: STACK_REASONS.unreachable,
      vmdVersion: null,
      health: null,
    });
    expect(STACK_REASONS.unreachable).toBe(
      "pap-vmd does not answer: run `sudo pap vm setup`, then start pap-vmd",
    );
  });

  it("an answer that is not a health report reads as unreachable", async () => {
    answer = { version: PAP };
    expect((await assessStack(vmd, PAP)).reason).toBe(STACK_REASONS.unreachable);
  });

  it("a pap-vmd of another version names both versions and `sudo pap vm setup` (M-version)", async () => {
    answer = { version: "1.3.0", ruleset: true, bridge: true, stateFreeMb: 1 };
    const view = await assessStack(vmd, PAP);
    expect(view.usable).toBe(false);
    expect(view.vmdVersion).toBe("1.3.0");
    expect(view.reason).toBe(STACK_REASONS.version("1.3.0", PAP));
    expect(view.reason).toBe("pap-vmd is at version 1.3.0, pap at 1.4.0: run `sudo pap vm setup`");
  });

  it("a pap-vmd without its ruleset is unusable (M-ruleset)", async () => {
    answer = { version: PAP, ruleset: false, bridge: true, stateFreeMb: 1 };
    expect((await assessStack(vmd, PAP)).reason).toBe(STACK_REASONS.ruleset);
  });

  it("a pap-vmd without pap0 is unusable (M-bridge)", async () => {
    answer = { version: PAP, ruleset: true, bridge: false, stateFreeMb: 1 };
    expect((await assessStack(vmd, PAP)).reason).toBe(STACK_REASONS.bridge);
  });
});

describe("the VM status view", () => {
  it("is the contract's view, with the host's ceilings (AVM-E33) and each agent's phase", async () => {
    const { status } = make();
    const view = await status.view("owner");
    expect(VmStatusView.safeParse(view).success).toBe(true);
    expect(view).toEqual({
      runtime: "vm",
      usable: true,
      reason: null,
      vmdVersion: PAP,
      claudeToken: "missing",
      // 8192 less the VM's own 512; 30000 free less the 1024 floor (M-floor).
      host: { memoryMb: 7680, cpus: 4, diskMb: 28_976 },
      agents: [
        { id: "helper-1a2b", phase: "running", migrated: false },
        { id: "scout-9c8d", phase: "stopped", migrated: false },
      ],
    });
  });

  it("an unreachable pap-vmd: unusable, no ceilings, the agents still listed (greyed by the page)", async () => {
    answer = new Error("x");
    vmd.failNext("vmd.health", "unavailable");
    const view = await make().status.view("owner");
    expect(view).toMatchObject({
      usable: false,
      reason: STACK_REASONS.unreachable,
      vmdVersion: null,
      host: null,
    });
    expect(view.agents).toHaveLength(2);
  });

  it("the disk ceiling never goes below zero when the floor is above the free space", async () => {
    answer = { version: PAP, ruleset: true, bridge: true, stateFreeMb: 100 };
    expect((await make().status.view("owner")).host).toMatchObject({ diskMb: 0 });
  });

  it("the Claude token reads missing, then set after a set, and the value is nowhere in the view (M-token)", async () => {
    const { status, claudeToken } = make();
    expect((await status.view("owner")).claudeToken).toBe("missing");
    claudeToken.set(TOKEN);
    const view = await status.view("owner");
    expect(view.claudeToken).toBe("set");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    claudeToken.clear();
    expect((await status.view("owner")).claudeToken).toBe("missing");
  });

  it("lists at most 32 agents, the contract's bound", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `agent-${String(i).padStart(4, "0")}` }));
    const view = await make({ agentsOf: () => many }).status.view("owner");
    expect(view.agents).toHaveLength(32);
    expect(VmStatusView.safeParse(view).success).toBe(true);
  });
});

describe("the host-mode view (AVM-P17)", () => {
  it("answers an unavailable stack, the token's state, and no VM", async () => {
    const { logger } = captureLogger();
    const claudeToken = createClaudeTokenStore({ secretsDir: join(root, "secrets"), logger });
    const view = createHostStatus(claudeToken);
    expect(view()).toEqual({
      runtime: "host",
      usable: false,
      reason: "not_configured",
      vmdVersion: null,
      claudeToken: "missing",
      agents: [],
    });
    claudeToken.set(TOKEN);
    expect(view().claudeToken).toBe("set");
    expect(JSON.stringify(view())).not.toContain(TOKEN);
  });
});

describe("require: the launch refusal", () => {
  it("lets a launch through on a usable stack", async () => {
    await expect(make().status.require()).resolves.toBeUndefined();
  });

  it("refuses `sandbox_unavailable` and logs the sentence, never the stack's raw error (M-unchecked)", async () => {
    answer = { version: "0.9.0", ruleset: true, bridge: true, stateFreeMb: 1 };
    const { status, lines } = make();
    const refused = await status.require().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PapError);
    expect((refused as PapError).code).toBe("sandbox_unavailable");
    expect(lines.find((line) => line.msg === "agent_vm_launch_refused")).toMatchObject({
      reason: STACK_REASONS.version("0.9.0", PAP),
    });
  });

  it("asks pap-vmd once per TTL window and again after it (M-ttl)", async () => {
    const { status } = make();
    await status.require();
    await status.require();
    expect(healthCalls).toBe(1);
    await clock.advance(STACK_TTL_MS + 1);
    await status.require();
    expect(healthCalls).toBe(2);
  });

  it("a refused stack is re-asked after the TTL, so a fixed stack launches again", async () => {
    answer = { version: PAP, ruleset: false, bridge: true, stateFreeMb: 1 };
    const { status } = make();
    await expect(status.require()).rejects.toMatchObject({ code: "sandbox_unavailable" });
    answer = { version: PAP, ruleset: true, bridge: true, stateFreeMb: 1 };
    await clock.advance(STACK_TTL_MS + 1);
    await expect(status.require()).resolves.toBeUndefined();
  });

  it("the owner's Recheck (a view) refreshes what the next launch sees", async () => {
    answer = { version: PAP, ruleset: false, bridge: true, stateFreeMb: 1 };
    const { status } = make();
    await expect(status.require()).rejects.toMatchObject({ code: "sandbox_unavailable" });
    answer = { version: PAP, ruleset: true, bridge: true, stateFreeMb: 1 };
    expect((await status.view("owner")).usable).toBe(true);
    await expect(status.require()).resolves.toBeUndefined();
  });
});
