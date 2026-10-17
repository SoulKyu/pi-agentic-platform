import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

interface Profile {
  autonomy: boolean;
  sandbox: boolean;
}
function setup(initial: Profile) {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const world = { ...initial };
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? {
              input: AgentInput.parse({
                name: "Atlas",
                trustedAutonomy: world.autonomy,
                sandbox: { required: world.sandbox },
              }),
              name: "Atlas",
              quarantined: false,
            }
          : null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  return world;
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const autonomous = (sessionId: string) => bed.service.agent.kindOf(sessionId)?.autonomous;

describe("autonomous (owner a6 ii, M11R220)", () => {
  it("is true only with the start-time snapshot and the registry both on", async () => {
    const world = setup({ autonomy: true, sandbox: false });
    const { sessionId } = await thread();
    expect(autonomous(sessionId)).toBe(true);
    world.autonomy = false;
    expect(autonomous(sessionId)).toBe(false);
  });

  it("is false when autonomy was switched on after the worker started", async () => {
    const world = setup({ autonomy: false, sandbox: false });
    const { sessionId } = await thread();
    world.autonomy = true;
    expect(autonomous(sessionId)).toBe(false);
  });

  it("is false with no worker, whatever the registry says", async () => {
    setup({ autonomy: true, sandbox: false });
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    expect(autonomous(sessionId)).toBe(false);
  });

  it("is false for a session that is not an agent thread", async () => {
    setup({ autonomy: true, sandbox: false });
    const { sessionId: id } = await bed.service.create(bed.work, OWNER);
    expect(autonomous(id)).toBe(false);
    expect(bed.service.agent.kindOf("missing")).toBeNull();
  });
});

describe("sandboxedThread (owner a5, M11R213)", () => {
  const sandboxed = (sessionId: string, ownerId = "u1") =>
    bed.service.agent.sandboxedThread(ownerId, sessionId);

  it("is true for a thread whose sandbox is required in the registry and at its worker's start", async () => {
    setup({ autonomy: false, sandbox: true });
    const { sessionId } = await thread();
    expect(sandboxed(sessionId)).toBe(true);
  });

  it("is false when the registry turned the sandbox off since", async () => {
    const world = setup({ autonomy: false, sandbox: true });
    const { sessionId } = await thread();
    world.sandbox = false;
    expect(sandboxed(sessionId)).toBe(false);
  });

  it("is false when the worker started without the sandbox and the registry has it on now", async () => {
    const world = setup({ autonomy: false, sandbox: false });
    const { sessionId } = await thread();
    world.sandbox = true;
    expect(sandboxed(sessionId)).toBe(false);
  });

  it("is true for a cold thread with the sandbox on in the registry", async () => {
    setup({ autonomy: false, sandbox: true });
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    expect(sandboxed(sessionId)).toBe(true);
  });

  it("is false for an owner session, a task row, another owner and an unknown id", async () => {
    setup({ autonomy: false, sandbox: true });
    const { sessionId: id } = await bed.service.create(bed.work, OWNER);
    const scratch = join(bed.dir, "pap", "agents", ".runs", ID, TASK);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const task = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["read"], preset: "read-only", tainted: false },
    });
    const own = await thread();
    expect(sandboxed(id)).toBe(false);
    expect(sandboxed(task.sessionId)).toBe(false);
    expect(sandboxed(own.sessionId, "u2")).toBe(false);
    expect(sandboxed("missing")).toBe(false);
  });
});
