import { afterEach, describe, expect, it } from "vitest";
import { createTriggerStore } from "./store.ts";
import { AGENT, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";
import { readTriggerSecret, writeTriggerSecret } from "./trigger-secrets.ts";
import { createAgentTriggerLink } from "./trigger-agent.ts";
import { newHookSecret } from "./hook-auth.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const HOOK_A = "0b1c2d3e-0a01-4000-8000-00000000000a";
const HOOK_B = "0b1c2d3e-0a02-4000-8000-00000000000b";
const HOOK_OTHER = "0b1c2d3e-0a03-4000-8000-00000000000c";
const MANUAL = "0b1c2d3e-0a04-4000-8000-00000000000d";
const BROKEN = "0b1c2d3e-0a05-4000-8000-00000000000e";

function world() {
  bed = createAutomationBed();
  const changes: string[] = [];
  const olds: Record<string, string> = {};
  for (const id of [HOOK_A, HOOK_B, HOOK_OTHER, BROKEN]) {
    olds[id] = newHookSecret();
    writeTriggerSecret(bed.secretsDir, id, olds[id] ?? "");
  }
  insertAgentTrigger(bed.db, bed.home, { id: HOOK_A, source: { type: "webhook" } });
  insertAgentTrigger(bed.db, bed.home, { id: HOOK_B, source: { type: "webhook" } });
  insertAgentTrigger(bed.db, bed.home, { id: HOOK_OTHER, agentId: "sage-0000", source: { type: "webhook" } });
  insertAgentTrigger(bed.db, bed.home, { id: MANUAL, source: { type: "manual" } });
  const link = createAgentTriggerLink({
    store: createTriggerStore(bed.db),
    secretsDir: bed.secretsDir,
    changed: (change) => void changes.push(change.triggerId),
    logger: bed.logger,
    rotate: (caller, triggerId) => bed.triggers.rotateSecret(caller, triggerId, true),
  });
  return { link, olds, changes };
}

describe("rotating the webhook secrets of one agent without a second step-up (quarantine, M11R115)", () => {
  it("rotates every webhook trigger of the agent, answers each new secret once and leaves the others", () => {
    const { link, olds } = world();
    const answer = link.rotateSecretsOf(bed.unconfirmed(), AGENT);
    expect(answer.failed).toEqual([]);
    expect(answer.secrets.map((entry) => entry.triggerId).sort()).toEqual([HOOK_A, HOOK_B].sort());
    for (const entry of answer.secrets) {
      expect(entry.name).toBe("Agent trigger");
      expect(entry.secret).not.toBe(olds[entry.triggerId]);
      expect(readTriggerSecret(bed.secretsDir, entry.triggerId)).toBe(entry.secret);
    }
    expect(readTriggerSecret(bed.secretsDir, HOOK_OTHER)).toBe(olds[HOOK_OTHER]);
  });

  it("audits each rotation by trigger and never the secret", () => {
    const { link } = world();
    const answer = link.rotateSecretsOf(bed.owner(), AGENT);
    const rows = bed.auditRows().filter((row) => row.reason === "automation trigger secret rotated");
    expect(rows).toHaveLength(2);
    expect(JSON.stringify([bed.auditRows(), bed.logs])).not.toContain(answer.secrets[0]?.secret);
  });

  it("a trigger that cannot be rotated is named in failed and the others still rotate", () => {
    const { link, olds } = world();
    bed.db.run("UPDATE triggers SET config = '{}' WHERE id = $id", { id: HOOK_A });
    const answer = link.rotateSecretsOf(bed.owner(), AGENT);
    expect(answer.failed).toEqual([HOOK_A]);
    expect(answer.secrets.map((entry) => entry.triggerId)).toEqual([HOOK_B]);
    expect(readTriggerSecret(bed.secretsDir, HOOK_A)).toBe(olds[HOOK_A]);
    expect(bed.logs).toContainEqual(
      expect.objectContaining({ msg: "trigger_secret_rotate_failed", triggerId: HOOK_A }),
    );
  });

  it("the public rotate still asks for the password", () => {
    world();
    expect(() => bed.triggers.rotateSecret(bed.unconfirmed(), HOOK_A)).toThrow(
      expect.objectContaining({ code: "step_up_required" }),
    );
  });
});
