import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import type { PlatformPort } from "../platform/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakeVmLaunch } from "./testing/fake-vm-launch.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

// R11 (RT-11): a VM session has no secret.request op and is sent no vault_update.
const ID = "atlas-1a2b";
const build = () =>
  createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { vmLaunch: fakeVmLaunch },
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

async function world(vm: boolean) {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  let vault: Record<string, string> = {};
  bed.service.agent.setAgentPorts({
    platform: { available: () => true } as unknown as PlatformPort,
    agents: {
      profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
      vaultOf: () => vault,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
      vmLayoutOf: () => (vm ? layoutOf("kata", bed.dir, { agentId: ID, taskKey: null }) : null),
      agentRunsInVm: () => vm,
    },
  });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: ID,
    role: "thread",
  });
  const row = bed.store.get(sessionId);
  if (!row) throw new Error("no row");
  const launch: AgentLaunch = {
    agent: { id: ID, name: "Atlas", role: "" },
    role: "thread",
    input: AgentInput.parse({ name: "Atlas" }),
    vault: {},
  };
  return { row, launch, setVault: (next: Record<string, string>) => (vault = next) };
}

describe("what a VM session's worker is given (R11)", () => {
  it("registers no secret.request op, and keeps the other ops of its type", async () => {
    const { row } = await world(true);
    const ops = bed.service.agent.platformOps(row);
    expect(ops).not.toContain("secret.request");
    expect(ops).toContain("agent.notify");
  });
  it("a host thread still has secret.request", async () => {
    const { row } = await world(false);
    expect(bed.service.agent.platformOps(row)).toContain("secret.request");
  });
  it("sends no vault_update to a VM session when the vault changes; a host session still gets one", async () => {
    const vm = await world(true);
    vm.setVault({ TOKEN: "value-1" });
    expect(bed.service.agent.vaultDrift(vm.row, vm.launch)).toBeNull();
    await bed.dispose();
    const host = await world(false);
    host.setVault({ TOKEN: "value-1" });
    expect(bed.service.agent.vaultDrift(host.row, host.launch)).toMatchObject({ type: "vault_update" });
  });
  // Mutant: the VM guard of egressScope removed (a raw egress_open of a VM row would get a host socket). Killed here.
  it("gives a VM row no egress scope, even with a host sandbox spec that has one (T8a)", async () => {
    const rules = {
      profile: "agent-thread",
      allowHosts: ["api.example"],
      trustedSources: [],
      sandbox: { required: true, network: true },
    } as never;
    const spec = {
      bwrap: "/usr/bin/bwrap",
      view: "host",
      home: "/h",
      writable: "/h",
      network: true,
      egress: { python: "/usr/bin/python3", forwarder: "/f.py" },
      hide: [],
    } as never;
    const vm = await world(true);
    expect(bed.service.agent.egressScope(vm.row, rules, spec)).toBeNull();
    await bed.dispose();
    const host = await world(false);
    expect(bed.service.agent.egressScope(host.row, rules, spec)).toMatchObject({ agentId: ID });
  });
});
