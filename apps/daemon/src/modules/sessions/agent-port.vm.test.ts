import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type VaultUpdateRecord } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

// R11 (RT-11): a vault change or a one-use value never reaches a live VM session, though its profile's sandbox switch is on.
const ID = "atlas-1a2b";
const RECORD: VaultUpdateRecord = { type: "vault_update", vault: { API_TOKEN: "v" }, once: [] };
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

async function live(vm: boolean) {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const agents: SessionsAgentDeps = {
    profileOf: () => ({ input: AgentInput.parse({ name: "A" }), name: "A", quarantined: false }),
    probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    onceOf: () => [{ id: "o".repeat(8), name: "ONE", value: "once-value", expiresAt: 9 }],
    vmLayoutOf: () => (vm ? layoutOf("kata", bed.dir, { agentId: ID, taskKey: null }) : null),
  };
  bed.service.agent.setAgentPorts({ agents });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: ID,
    role: "thread",
  });
  return sessionId;
}
const received = () => bed.spawned[0]?.sent.filter((record) => record.type === "vault_update") ?? [];

describe("sendToAgent and a VM session (R11)", () => {
  it("tells a live VM session nothing: not a vault update, not a one-use value, not a targeted send", async () => {
    const sessionId = await live(true);
    expect(bed.service.agentSessions.sendToAgent("u1", ID, RECORD)).toBe(0);
    expect(bed.service.agentSessions.sendToAgent("u1", ID, RECORD, sessionId)).toBe(0);
    expect(received()).toEqual([]);
    expect(bed.service.agentSessions.runsInVm("u1", sessionId)).toBe(true);
    expect(bed.service.agentSessions.runsInVm("u2", sessionId)).toBe(false);
  });
  it("still tells a host session, with its one-use values", async () => {
    await live(false);
    expect(bed.service.agentSessions.sendToAgent("u1", ID, RECORD)).toBe(1);
    expect(received()).toEqual([{ ...RECORD, once: [expect.objectContaining({ name: "ONE" })] }]);
  });
});
