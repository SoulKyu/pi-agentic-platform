import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type VaultUpdateRecord } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ATLAS = "atlas-1a2b";
const BOLT = "bolt-0001";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const RECORD: VaultUpdateRecord = { type: "vault_update", vault: { API_TOKEN: "v" }, once: [] };
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
let vault: Record<string, string> = {};
afterEach(() => bed.dispose());

function setup(sandboxRequired = true, options?: BedOptions): void {
  vault = {};
  bed = build(options);
  for (const id of [ATLAS, BOLT])
    mkdirSync(join(bed.dir, "pap", "agents", id), { recursive: true, mode: 0o700 });
  const agents: SessionsAgentDeps = {
    profileOf: (ownerId, agentId) =>
      ownerId === "u1" && [ATLAS, BOLT].includes(agentId)
        ? {
            input: AgentInput.parse({ name: "A", sandbox: { required: sandboxRequired, network: false } }),
            name: "A",
            quarantined: false,
          }
        : null,
    vaultOf: () => ({ ...vault }),
  };
  bed.service.agent.setAgentPorts({ agents });
}
const thread = (agentId: string) =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId, role: "thread" });
const vaultUpdates = (index: number) =>
  bed.spawned[index]?.sent.filter((record) => record.type === "vault_update") ?? [];

describe("sendToAgent (M11R86)", () => {
  it("reaches the agent's thread and its running task, and no other agent's worker", async () => {
    setup();
    await thread(ATLAS);
    await thread(BOLT);
    const scratch = join(bed.dir, "pap", "agents", ".runs", ATLAS, TASK);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ATLAS,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["bash"], preset: "full", tainted: false },
    });
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, RECORD)).toBe(2);
    expect(vaultUpdates(0)).toEqual([RECORD]);
    expect(vaultUpdates(1)).toEqual([]);
    expect(vaultUpdates(2)).toEqual([RECORD]);
  });

  it("reaches a VM worker whatever the profile's retired sandbox switch says", async () => {
    setup(false);
    await thread(ATLAS);
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, RECORD)).toBe(1);
    expect(vaultUpdates(0)).toEqual([RECORD]);
  });

  it("does not reach another owner's call or a child", async () => {
    setup();
    const { sessionId } = await thread(ATLAS);
    expect(bed.service.agentSessions.sendToAgent("u2", ATLAS, RECORD)).toBe(0);
    // The same worker, recorded as a child of another session: never told (RT-07).
    bed.db.run("UPDATE sessions SET agent_role = 'child', parent_session_id = 'other' WHERE id = $id", {
      id: sessionId,
    });
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, RECORD)).toBe(0);
    expect(vaultUpdates(0)).toEqual([]);
  });

  it("does not reach a cold thread (the next start reads the vault)", async () => {
    setup();
    const { sessionId } = await thread(ATLAS);
    expect(bed.service.agentSessions.releaseIdle("u1", sessionId)).toBe("released");
    await bed.spawned[0]?.exited;
    expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, RECORD)).toBe(0);
  });
});

describe("a vault change while the worker boots (M11R86)", () => {
  const ready = (index: number) =>
    bed.spawned[index]?.emit({
      type: "ready",
      sessionId: `pi-${index}`,
      sessionFile: join(bed.dir, `pi-${index}.jsonl`),
      piVersion: "1.1.0",
      leafId: null,
      sessionName: null,
    });
  const booting = async (role: "thread" | "task") => {
    setup(true, { start: () => ({ kind: "silent" }) });
    vault = { OLD_ONE: "o", KEEP: "k" };
    const scratch = join(bed.dir, "pap", "agents", ".runs", ATLAS, TASK);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const starting =
      role === "thread"
        ? thread(ATLAS)
        : bed.service.agentSessions.createAgentSession({
            ownerId: "u1",
            agentId: ATLAS,
            role: "task",
            scratch,
            task: { mode: "supervised", tools: ["bash"], preset: "full", tainted: false },
          });
    await vi.waitFor(() => expect(bed.spawned).toHaveLength(1), { timeout: 5000 });
    return { starting };
  };

  it.each(["thread", "task"] as const)(
    "a set and a delete between the gate and ready reach a %s worker",
    async (role) => {
      const { starting } = await booting(role);
      const init = bed.spawned[0]?.sent.find((record) => record.type === "init");
      expect(init).toMatchObject({ vault: { OLD_ONE: "o", KEEP: "k" } });
      // The worker is not live yet: the port tells nobody, the change must not be lost.
      vault = { KEEP: "k", NEW_ONE: "n" };
      expect(bed.service.agentSessions.sendToAgent("u1", ATLAS, RECORD)).toBe(0);
      ready(0);
      await starting;
      expect(vaultUpdates(0)).toEqual([
        { type: "vault_update", vault: { KEEP: "k", NEW_ONE: "n" }, once: [] },
      ]);
    },
  );

  it("parses the update as the secrets module does: a vault the contract refuses is not sent, and the start goes on", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const { logger } = captureLogger();
    setup(true, {
      start: () => ({ kind: "silent" }),
      logger: { ...logger, warn: (msg, fields) => void lines.push({ msg, ...fields }) },
    });
    vault = { OLD_ONE: "o" };
    const starting = thread(ATLAS);
    await vi.waitFor(() => expect(bed.spawned).toHaveLength(1), { timeout: 5000 });
    vault = { "not a vault name": "x" };
    ready(0);
    await starting;
    expect(vaultUpdates(0)).toEqual([]);
    expect(lines.find((line) => line["msg"] === "vault_update_invalid")).toMatchObject({ agentId: ATLAS });
    expect(JSON.stringify(lines)).not.toContain("not a vault name");
  });

  it("sends nothing when the vault is the one init carried", async () => {
    const { starting } = await booting("thread");
    ready(0);
    await starting;
    expect(vaultUpdates(0)).toEqual([]);
  });
});
