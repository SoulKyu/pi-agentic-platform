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
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  await bed.service.agentSessions.createAgentSession({
    ownerId: OWNER.userId,
    agentId: "atlas-1a2b",
    role: "thread",
  });
}

describe("the host worker of a claude-bridge agent (ADR 0080)", () => {
  it("gets CLAUDE_CONFIG_DIR in the agent's home and never IS_SANDBOX", async () => {
    await launchAgent(true);
    expect(bed.spawnEnvs[0]).toEqual({
      CLAUDE_CONFIG_DIR: join(bed.dir, "pap", "agents", "atlas-1a2b", ".claude"),
    });
  });

  it("gets neither for any other agent", async () => {
    await launchAgent(false);
    expect(bed.spawnEnvs[0]).toBeUndefined();
  });
});
