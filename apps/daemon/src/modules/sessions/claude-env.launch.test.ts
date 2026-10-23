import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let bed: ReturnType<typeof build>;
const build = () =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, {});
afterEach(() => bed.dispose());

async function launchAgent(bridge: boolean) {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", "atlas-1a2b"), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({
        input: AgentInput.parse({ name: "Atlas", sandbox: { required: false } }),
        name: "Atlas",
        quarantined: false,
      }),
      claudeEnvOf: (_input, where) =>
        Promise.resolve<Record<string, string>>(bridge ? { CLAUDE_CONFIG_DIR: `${where.home}/.claude` } : {}),
    },
  });
  await bed.service.agentSessions.createAgentSession({
    ownerId: OWNER.userId,
    agentId: "atlas-1a2b",
    role: "thread",
  });
}

describe("the worker of an agent without the bridge (ADR 0080)", () => {
  it("gets neither for any other agent", async () => {
    await launchAgent(false);
    expect(bed.spawnEnvs[0]).toBeUndefined();
  });
});
