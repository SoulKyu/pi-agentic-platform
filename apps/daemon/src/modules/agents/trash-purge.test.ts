import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { AgentVmLink } from "./links.ts";
import { createTrashPurge } from "./trash-purge.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "row dropped before the purge" (the failure case keeps nothing),
 * "no ownership check" (the other-owner case), "step-up skipped" (the password case), "host mode purges" (the host case).
 */
let bed: AgentsBed;
afterEach(() => bed.dispose());

const calls: string[] = [];
const link = (fail = false): AgentVmLink => ({
  stop: async () => {},
  dispose: async () => {},
  purge: async (id) => {
    calls.push(`purge:${id}`);
    if (fail) throw new Error("vmd down");
  },
  resume: () => {},
});

async function deleted(vm: AgentVmLink | undefined) {
  calls.length = 0;
  bed = createAgentsBed(vm ? { extra: { vm } } : {});
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  await bed.agents.remove(bed.owner(), id);
  const purge = createTrashPurge({
    store: bed.agents.store,
    links: bed.agents.links,
    clock: bed.clock,
    audit: bed.audit,
    logger: silentLogger,
    requireStepUp: (caller, now) => {
      if ((caller.stepUpUntil ?? 0) <= now) throw new PapError("step_up_required");
    },
  });
  return { id, purge };
}

describe("agents.purgeTrash (RT-40)", () => {
  it("purges the agent's trash in pap-vmd and the daemon, then drops its trash entry and audits it", async () => {
    const { id, purge } = await deleted(link());
    await purge.purge(bed.owner(), id);
    expect(calls).toEqual([`purge:${id}`]);
    expect(bed.agents.trash(bed.owner())).toEqual({ agents: [] });
    expect(bed.auditRows().at(-1)).toMatchObject({ reason: "agent trash purged", kind: "policy" });
  });

  it("keeps the entry, so the owner can ask again, when the purge fails; a typed refusal keeps its code", async () => {
    const { id, purge } = await deleted(link(true));
    await expect(purge.purge(bed.owner(), id)).rejects.toMatchObject({ code: "command_failed" });
    expect(bed.agents.trash(bed.owner()).agents).toHaveLength(1);
  });

  it("asks for the password", async () => {
    const { id, purge } = await deleted(link());
    await expect(purge.purge(bed.unconfirmed(), id)).rejects.toMatchObject({ code: "step_up_required" });
    expect(calls).toEqual([]);
  });

  it("knows only the owner's own deleted agents", async () => {
    const { id, purge } = await deleted(link());
    await expect(purge.purge(bed.owner({ userId: "u2" }), id)).rejects.toMatchObject({ code: "not_found" });
    await expect(purge.purge(bed.owner(), "nobody-0000")).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toEqual([]);
  });

  it("is sandbox_unavailable in host mode, before anything else", async () => {
    const { id, purge } = await deleted(undefined);
    await expect(purge.purge(bed.unconfirmed(), id)).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(bed.agents.trash(bed.owner()).agents).toHaveLength(1);
  });
});
