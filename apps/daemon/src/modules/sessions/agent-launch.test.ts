import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type ApprovalMode } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (policy: ReturnType<typeof fakePolicyPort>) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, { policy });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

it("a start that throws before the spawn drops the start-time profile it had set (W5-R26)", async () => {
  const policy = fakePolicyPort();
  bed = build(policy);
  mkdirSync(join(bed.dir, "pap", "agents", "atlas-1a2b"), { recursive: true, mode: 0o700 });
  const profile = { mode: "auto-accept-edits" as ApprovalMode };
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({
        input: AgentInput.parse({ name: "Atlas", mode: profile.mode }),
        name: "Atlas",
        quarantined: false,
      }),
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: "atlas-1a2b",
    role: "thread",
  });
  bed.service.agentSessions.releaseIdle("u1", sessionId);
  await bed.spawned[0]?.exited;
  // The rules cannot be composed: the throw comes after the snapshot was set and before any worker exists.
  const real = policy.sessionPolicy;
  let armed = true;
  policy.sessionPolicy = (...args) => {
    if (armed) throw new Error("rules failed");
    return real(...args);
  };
  profile.mode = "supervised";
  // Exactly the compose failure: a refusal of the gate (no snapshot set yet) would prove nothing here.
  await expect(bed.service.reopen(sessionId, OWNER)).rejects.toThrow(new Error("rules failed"));
  armed = false;
  expect(bed.spawned).toHaveLength(1);
  // No worker runs, so the view follows the registry again, not the profile of the start that failed.
  profile.mode = "full-access";
  expect(bed.service.modeOf("u1", sessionId)).toBe("full-access");
});
