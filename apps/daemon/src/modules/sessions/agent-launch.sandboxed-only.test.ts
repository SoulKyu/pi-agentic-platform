import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import type { WorkerRecord } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
let bed: ReturnType<typeof build>;
const build = (options?: Parameters<typeof createServiceBed>[1]) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
afterEach(() => bed.dispose());

// Agents run in microVMs only: "the gate gives no sandbox" is a machine with no VM stack (`vm.up = false`).
const profile = { mode: "supervised" as "supervised" | "full-access" };
const vm = { up: true };
function setup(options?: Parameters<typeof createServiceBed>[1]) {
  bed = build(options);
  profile.mode = "supervised";
  vm.up = true;
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? {
              input: AgentInput.parse({ name: "Atlas", mode: profile.mode }),
              name: "Atlas",
              quarantined: false,
            }
          : null,
      vmLayoutOf: (row) =>
        vm.up && row.agentId !== undefined
          ? layoutOf("process", join(bed.dir, "pap"), { agentId: row.agentId, taskKey: null })
          : null,
    },
  });
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const cold = async (): Promise<string> => {
  const { sessionId } = await thread();
  bed.service.agentSessions.releaseIdle("u1", sessionId);
  await bed.spawned[0]?.exited;
  return sessionId;
};
const prompt = (sessionId: string, sandboxedOnly: boolean) =>
  bed.service.automation.prompt({ ownerId: "u1", sessionId, text: "go", sandboxedOnly });

describe("a sandbox-only prompt (owner a5, M11R214)", () => {
  it("refuses a cold launch whose gate gives no VM: no spawn, no start-time profile", async () => {
    setup();
    const sessionId = await cold();
    vm.up = false;
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    expect(bed.spawned).toHaveLength(1);
    // No start-time profile is left: the mode in force follows an edit of the registry at once.
    profile.mode = "full-access";
    expect(bed.service.modeOf("u1", sessionId)).toBe("full-access");
  });

  it("starts a cold launch whose gate gives a VM", async () => {
    setup();
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId, true))).toBeNull();
    expect(bed.spawned).toHaveLength(2);
  });

  it("refuses a warm worker that is no VM's (an owner session) before it gets the prompt", async () => {
    setup();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    expect(bed.spawned[0]?.requests.some((request) => request.type === "prompt")).toBe(false);
  });

  it("removes the mark on every path: a later plain prompt on the same cold session starts", async () => {
    setup();
    const sessionId = await cold();
    vm.up = false;
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    vm.up = true;
    expect(await codeOf(prompt(sessionId, false))).toBeNull();
    expect(bed.spawned).toHaveLength(2);
  });

  it("leaves no mark when the prompt is refused for capacity before the try", async () => {
    setup({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const sessionId = await cold();
    const owner = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(prompt(sessionId, true))).toBe("capacity");
    bed.service.releaseIdle("u1", owner.sessionId);
    await bed.spawned[1]?.exited;
    expect(await codeOf(prompt(sessionId, false))).toBeNull();
  });
});

describe("a sandbox-only prompt on a warm worker that a pending memory release restarts (M11 sweep, 31 m3)", () => {
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
  } as WorkerRecord;

  it("a VM worker has no memory release to restart: the prompt goes to the warm worker, no second worker", async () => {
    const policy = fakePolicyPort();
    setup({ policy });
    const { sessionId } = await thread();
    // A taint finds a dialog open: the release stays pending until the next prompt.
    bed.spawned[0]?.emit(HOLD);
    policy.markTainted("u1", sessionId);
    await bed.service.respondDialog({ sessionId, dialogId: "hold", response: { answer: "deny" } }, OWNER);
    expect(await codeOf(prompt(sessionId, true))).toBeNull();
    expect(bed.spawned).toHaveLength(1);
  });
});
