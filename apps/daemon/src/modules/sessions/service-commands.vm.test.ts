import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { fakeVmLaunch } from "./testing/fake-vm-launch.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { VM_REFUSALS } from "./vm-rules.ts";

// R37 (RT-06): export_html would write a host path from inside the VM.
const ID = "atlas-1a2b";
let bed: ReturnType<typeof build>;
const logs = captureLogger();
const build = () =>
  createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { logger: logs.logger, vmLaunch: fakeVmLaunch },
  );
afterEach(() => bed.dispose());

async function world(vm: boolean) {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
      vmLayoutOf: () => (vm ? layoutOf("kata", bed.dir, { agentId: ID, taskKey: null }) : null),
      agentRunsInVm: () => vm,
    },
  });
  return (
    await bed.service.agentSessions.createAgentSession({ ownerId: OWNER.userId, agentId: ID, role: "thread" })
  ).sessionId;
}

describe("exporting a VM session (R37)", () => {
  it("is sandbox_unavailable, starts no worker, leaves no export entry and logs the sentence", async () => {
    const sessionId = await world(true);
    const before = bed.spawned.length;
    expect(await codeOf(bed.service.exportHtml(sessionId, OWNER))).toBe("sandbox_unavailable");
    expect(bed.spawned.length).toBe(before);
    expect(readdirSync(bed.exportsDir)).toEqual([]);
    expect(JSON.stringify(logs.lines)).toContain(VM_REFUSALS.export);
  });
});
