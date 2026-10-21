import { existsSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { AgentVmLink } from "./links.ts";
import { createQuarantine } from "./quarantine.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "vm step after the others" (the quarantine order case), "vm step missing
 * from delete" / "dispose before stop" (the delete order case), "dispose failure swallowed" (the failure case), "disk dropped
 * by quarantine" (the keeps-the-disk case), "resume on pause" (the resume case), "resume not called" (the resume case).
 */
let bed: AgentsBed;
afterEach(() => bed.dispose());

function link(log: string[], fail: ReadonlySet<string> = new Set()): AgentVmLink {
  const call = (name: string): void => {
    log.push(name);
    if (fail.has(name)) throw new Error(`${name} failed`);
  };
  return {
    stop: async (id) => call(`stop:${id}`),
    dispose: async (id, stamp) => call(`dispose:${id}:${stamp}`),
    purge: async (id) => call(`purge:${id}`),
    resume: (id) => call(`resume:${id}`),
  };
}

describe("delete (RT-40, T15 brief)", () => {
  it("stops the agent's VMs, trashes its disk and mirrors, then moves the home and drops the row", async () => {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    const home = join(bed.papHome, "agents", id);
    bed.agents.setLinks({ vault: { drop: () => void log.push(`vault home=${existsSync(home)}`) } });
    log.length = 0;
    const answer = await bed.agents.remove(bed.owner(), id);
    expect(log).toEqual([`stop:${id}`, `dispose:${id}:${bed.clock.now()}`, "vault home=true"]);
    expect(answer.trashedAs).toBe(`${id}-${bed.clock.now()}`);
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });

  it("leaves the home and the row when the VM step fails, and a retry finishes", async () => {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log, new Set(["dispose:atlas-0000:1700000000000"])) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    await expect(bed.agents.remove(bed.owner(), id)).rejects.toMatchObject({ code: "command_failed" });
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(true);
    expect(bed.agents.port.get("u1", id)).not.toBeNull();
    await bed.clock.advance(1);
    await expect(bed.agents.remove(bed.owner(), id)).resolves.toMatchObject({
      trashedAs: expect.any(String),
    });
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });

  it("sends the agent's files to the trash after its disk, before the home moves, and in host mode too", async () => {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.setLinks({
      files: { paths: () => [], dispose: (agentId, stamp) => void log.push(`files:${agentId}:${stamp}`) },
    });
    log.length = 0;
    await bed.agents.remove(bed.owner(), id);
    expect(log).toEqual([`stop:${id}`, `dispose:${id}:${bed.clock.now()}`, `files:${id}:${bed.clock.now()}`]);
    bed.dispose();
    const host: string[] = [];
    bed = createAgentsBed();
    const { id: hostId } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.setLinks({ files: { paths: () => [], dispose: (agentId) => void host.push(agentId) } });
    await bed.agents.remove(bed.owner(), hostId);
    expect(host).toEqual([hostId]);
  });

  it("leaves the home and the row when the files cannot be trashed, and a retry finishes", async () => {
    bed = createAgentsBed();
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    let failing = true;
    bed.agents.setLinks({
      files: {
        paths: () => [],
        dispose: () => {
          if (failing) throw new Error("disk full");
        },
      },
    });
    await expect(bed.agents.remove(bed.owner(), id)).rejects.toMatchObject({ code: "command_failed" });
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(true);
    failing = false;
    await expect(bed.agents.remove(bed.owner(), id)).resolves.toBeDefined();
  });

  it("changes nothing in host mode (no VM link)", async () => {
    bed = createAgentsBed();
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    await expect(bed.agents.remove(bed.owner(), id)).resolves.toBeDefined();
  });
});

describe("quarantine (RT-41)", () => {
  async function run(fail: ReadonlySet<string> = new Set()) {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log, fail) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.setLinks({
      automation: {
        busy: () => false,
        deleteTriggersOf: () => undefined,
        cancelQueuedOf: () => undefined,
        cancelAllOf: async () => (log.push("tasks"), 0),
      },
      subagents: { cancelAllOf: () => (log.push("subagents"), 0) },
    });
    const quarantine = createQuarantine({
      store: bed.agents.store,
      links: bed.agents.links,
      guard: bed.guard,
      lock: async (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => {},
      changed: vi.fn(),
    });
    log.length = 0;
    const answer = await quarantine.run(bed.owner(), id);
    return { id, log, answer };
  }

  it("stops the VMs right after the pause and before every other step, and keeps the disk", async () => {
    const { id, log, answer } = await run();
    expect(log).toEqual([`stop:${id}`, "tasks", "subagents"]);
    expect(log.some((entry) => entry.startsWith("dispose") || entry.startsWith("purge"))).toBe(false);
    expect(answer.errors).toEqual([]);
    expect(bed.agents.port.get("u1", id)?.paused).toBe(true);
  });

  it("reports a VM that would not stop as the `vm` step and still runs the others", async () => {
    const { log, answer } = await run(new Set(["stop:atlas-0000"]));
    expect(answer.errors).toEqual([{ step: "vm", code: "failed" }]);
    expect(log).toContain("tasks");
  });
});

describe("the owner's Resume (T7: runtime.resume only from here)", () => {
  it("tells the VM runtime to forget the crashes when the switch goes back on", async () => {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.pause(bed.owner(), id, true);
    expect(log).toEqual([]);
    bed.agents.pause(bed.owner(), id, false);
    expect(log).toEqual([`resume:${id}`]);
  });

  it("does not tell it when the resume is refused", async () => {
    const log: string[] = [];
    bed = createAgentsBed({ extra: { vm: link(log) } });
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.store.quarantine("u1", id, bed.clock.now());
    expect(() => bed.agents.setPaused("u1", id, false)).toThrow(PapError);
    expect(log).toEqual([]);
  });
});
