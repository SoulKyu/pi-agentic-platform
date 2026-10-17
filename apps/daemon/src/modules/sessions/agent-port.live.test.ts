import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

function setup(options?: BedOptions): void {
  bed = build(options);
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const agents: SessionsAgentDeps = {
    profileOf: (ownerId, agentId) =>
      ownerId === "u1" && agentId === ID
        ? { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }
        : null,
    vaultOf: () => ({}),
    probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
  };
  bed.service.agent.setAgentPorts({ agents });
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const sentTypes = () => bed.spawned[0]?.requests.map((request) => request.type) ?? [];

describe("applyLive (M11R47)", () => {
  it("sends the new model and thinking level to a worker that is up, and says applied", async () => {
    setup({ replies: { set_model: { success: true }, set_thinking_level: { success: true } } });
    const { sessionId } = await thread();
    const answer = await bed.service.agentSessions.applyLive({
      ownerId: "u1",
      sessionId,
      model: { provider: "p", modelId: "m" },
      thinking: "high",
    });
    expect(answer).toBe("applied");
    expect(bed.spawned[0]?.requests).toEqual([
      expect.objectContaining({ type: "set_model", provider: "p", modelId: "m" }),
      expect.objectContaining({ type: "set_thinking_level", level: "high" }),
    ]);
  });

  it("does not start a worker for a cold thread: the next start reads the profile", async () => {
    setup();
    const { sessionId } = await thread();
    expect(bed.service.agentSessions.releaseIdle("u1", sessionId)).toBe("released");
    await bed.spawned[0]?.exited;
    const answer = await bed.service.agentSessions.applyLive({
      ownerId: "u1",
      sessionId,
      model: { provider: "p", modelId: "m" },
    });
    expect(answer).toBe("cold");
    expect(bed.spawned).toHaveLength(1);
    expect(sentTypes()).not.toContain("set_model");
  });

  it("answers busy when the worker refuses a model change under a run", async () => {
    setup({ replies: { set_model: { success: false, error: "pap:session_busy" } } });
    const { sessionId } = await thread();
    const answer = await bed.service.agentSessions.applyLive({
      ownerId: "u1",
      sessionId,
      model: { provider: "p", modelId: "m" },
    });
    expect(answer).toBe("busy");
  });

  it("is not_found for another owner's session and for a session that is not an agent's", async () => {
    setup();
    const { sessionId } = await thread();
    const plain = await bed.service.create(bed.work, OWNER);
    expect(
      await codeOf(bed.service.agentSessions.applyLive({ ownerId: "u2", sessionId, thinking: "low" })),
    ).toBe("not_found");
    expect(
      await codeOf(
        bed.service.agentSessions.applyLive({ ownerId: "u1", sessionId: plain.sessionId, thinking: "low" }),
      ),
    ).toBe("not_found");
  });
});
