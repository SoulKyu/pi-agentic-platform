import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type InitRecord, type WorkerRecord } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const inits: InitRecord[] = [];
/** What each worker (by spawn order) says before `ready`: a taint reported while the worker boots. */
const before = new Map<number, WorkerRecord[]>();
const build = (policy: ReturnType<typeof fakePolicyPort>) =>
  createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    {
      policy,
      start: (index, init) => {
        inits.push(init);
        const said = before.get(index);
        return said ? { kind: "ready", before: said } : { kind: "ready" };
      },
    },
  );
let bed: ReturnType<typeof build>;
afterEach(() => {
  inits.length = 0;
  before.clear();
  return bed.dispose();
});

const CLOSED = { profile: "", trust: "untrusted" };

function withAgent(policy: ReturnType<typeof fakePolicyPort>) {
  bed = build(policy);
  mkdirSync(join(bed.dir, "pap", "agents", "atlas-1a2b"), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({
        input: AgentInput.parse({ name: "Atlas", memory: { capture: "auto", save: "staged" } }),
        name: "Atlas",
        quarantined: false,
      }),
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
}

describe("memory trust at a worker's start (M11R142)", () => {
  it("an untainted plain session gets no entry and no environment", async () => {
    bed = build(fakePolicyPort());
    await bed.service.create(bed.work, OWNER);
    expect(inits[0]?.memory).toBeUndefined();
    expect(bed.spawnEnvs[0]).toBeUndefined();
  });

  it("a plain session tainted before its worker starts gets the closed entry and PI_MEM0_CAPTURE=0", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    policy.markTainted("u1", sessionId);
    await bed.spawned[0]?.exited;
    await bed.service.reopen(sessionId, OWNER);
    expect(inits[1]?.memory).toEqual(CLOSED);
    expect(bed.spawnEnvs[1]).toEqual({ PI_MEM0_CAPTURE: "0" });
  });

  it("an untainted agent thread is trusted with its policy; once tainted its next worker is untrusted under its profile", async () => {
    const policy = fakePolicyPort();
    withAgent(policy);
    const { sessionId } = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: "atlas-1a2b",
      role: "thread",
    });
    expect(inits[0]?.memory).toEqual({
      profile: "atlas-1a2b",
      trust: "trusted",
      memory: { capture: "auto", save: "staged" },
    });
    expect(bed.spawnEnvs[0]).toBeUndefined();
    policy.markTainted("u1", sessionId);
    await bed.spawned[0]?.exited;
    await bed.service.reopen(sessionId, OWNER);
    expect(inits[1]?.memory).toEqual({ profile: "atlas-1a2b", trust: "untrusted" });
    expect(bed.spawnEnvs[1]).toBeUndefined();
  });
});

describe("a taint releases the worker (M11R143)", () => {
  it("a worker that started untainted is released once its session is tainted", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    policy.markTainted("u1", sessionId);
    await bed.spawned[0]?.exited;
    expect(bed.spawned).toHaveLength(1);
  });

  it("an agent thread whose session only changed mode keeps its worker and its trusted entry", async () => {
    const policy = fakePolicyPort();
    withAgent(policy);
    const { sessionId } = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: "atlas-1a2b",
      role: "thread",
    });
    // A mode change tells the same listeners a taint does; it must not release anything.
    policy.setMode("u1", sessionId, "supervised");
    let ended = false;
    void bed.spawned[0]?.exited.then(() => (ended = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(ended).toBe(false);
  });

  it("a worker that started tainted is not released again by a later change", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    policy.markTainted("u1", sessionId);
    await bed.spawned[0]?.exited;
    await bed.service.reopen(sessionId, OWNER);
    policy.setMode("u1", sessionId, "supervised");
    let ended = false;
    void bed.spawned[1]?.exited.then(() => (ended = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(ended).toBe(false);
  });
});

const TAINT = { type: "taint", epoch: 0 } as WorkerRecord;
const HOLD = {
  type: "approval_request",
  id: "hold",
  category: "exec",
  title: "hold",
  message: "hold",
  answers: ["deny", "once"],
  tool: "bash",
  key: "hold",
  toolCallId: "hold",
} as never;

/** The release is enforced at the next prompt: pi-mem0 reads nothing mid-run, so a worker that kept running would capture with its start-time trust. */
describe("a deferred release is enforced at the next prompt (M11R143)", () => {
  it("a taint that finds a dialog open at settle: the prompt after the dialog closed runs on a new, closed worker", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(HOLD);
    policy.markTainted("u1", sessionId);
    await bed.service.respondDialog({ sessionId, dialogId: "hold", response: { answer: "deny" } }, OWNER);
    // The dialog closed and nothing retried: only the next prompt can act.
    expect(bed.spawned).toHaveLength(1);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(inits[1]?.memory).toEqual(CLOSED);
    expect(bed.spawnEnvs[1]).toEqual({ PI_MEM0_CAPTURE: "0" });
    await bed.spawned[0]?.exited;
  });

  it("a taint reported while a reopen boots: the reopened worker is released, and the prompt gets a closed one", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.service.releaseIdle(OWNER.userId, sessionId);
    await bed.spawned[0]?.exited;
    before.set(1, [TAINT]);
    await bed.service.reopen(sessionId, OWNER);
    await bed.spawned[1]?.exited;
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(inits[2]?.memory).toEqual(CLOSED);
  });

  it("a taint replayed before the worker joins `live` (a new session): the first prompt gets a closed worker", async () => {
    const policy = fakePolicyPort();
    bed = build(policy);
    before.set(0, [TAINT]);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(inits[0]?.memory).toBeUndefined();
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(inits[1]?.memory).toEqual(CLOSED);
    await bed.spawned[0]?.exited;
  });

  it("an untainted session's prompts keep one worker", async () => {
    bed = build(fakePolicyPort());
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "one" }, OWNER);
    await bed.service.prompt({ sessionId, text: "two" }, OWNER);
    expect(bed.spawned).toHaveLength(1);
  });
});
