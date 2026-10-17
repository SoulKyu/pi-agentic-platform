import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformPort } from "../platform/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

// M11a final review M5: no `secret_request` tool for a thread whose start-time profile has no sandbox (it would only refuse).
const ID = "atlas-1a2b";
let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

async function opsOf(sandbox: boolean): Promise<string[]> {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    platform: { available: () => true } as unknown as PlatformPort,
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? {
              input: AgentInput.parse({ name: "Atlas", sandbox: { required: sandbox } }),
              name: "Atlas",
              quarantined: false,
            }
          : null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: ID,
    role: "thread",
  });
  const row = bed.store.get(sessionId);
  if (!row) throw new Error("no row");
  return bed.service.agent.platformOps(row);
}

describe("the ops a thread's worker is given", () => {
  it("holds secret.request only when the start-time profile has the sandbox on", async () => {
    expect(await opsOf(true)).toContain("secret.request");
    await bed.dispose();
    const off = await opsOf(false);
    expect(off).not.toContain("secret.request");
    expect(off).toContain("agent.notify");
  });
});
