import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
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

const profile = { mode: "supervised" as "supervised" | "full-access" };
function setup(sandboxRequired: boolean, options?: Parameters<typeof createServiceBed>[1]) {
  bed = build(options);
  profile.mode = "supervised";
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? {
              input: AgentInput.parse({
                name: "Atlas",
                mode: profile.mode,
                sandbox: { required: sandboxRequired },
              }),
              name: "Atlas",
              quarantined: false,
            }
          : null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
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
  it("refuses a cold launch whose gate gives no sandbox: no spawn, no start-time profile", async () => {
    setup(false);
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    expect(bed.spawned).toHaveLength(1);
    // No start-time profile is left: the mode in force follows an edit of the registry at once.
    profile.mode = "full-access";
    expect(bed.service.modeOf("u1", sessionId)).toBe("full-access");
  });

  it("starts a cold launch whose gate gives a sandbox", async () => {
    setup(true);
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId, true))).toBeNull();
    expect(bed.spawned).toHaveLength(2);
  });

  it("starts a cold launch without a sandbox when the prompt is not sandbox-only", async () => {
    setup(false);
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId, false))).toBeNull();
    expect(bed.spawned).toHaveLength(2);
  });

  it("refuses a warm session whose worker has no sandbox before the worker gets the prompt", async () => {
    setup(false);
    const { sessionId } = await thread();
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    expect(bed.spawned[0]?.requests.some((request) => request.type === "prompt")).toBe(false);
  });

  it("removes the mark on every path: a later plain prompt on the same cold session starts", async () => {
    setup(false);
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId, true))).toBe("sandbox_unavailable");
    expect(await codeOf(prompt(sessionId, false))).toBeNull();
    expect(bed.spawned).toHaveLength(2);
  });

  it("leaves no mark when the prompt is refused for capacity before the try", async () => {
    setup(false, { limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const sessionId = await cold();
    const owner = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(prompt(sessionId, true))).toBe("capacity");
    bed.service.releaseIdle("u1", owner.sessionId);
    await bed.spawned[1]?.exited;
    expect(await codeOf(prompt(sessionId, false))).toBeNull();
  });
});
