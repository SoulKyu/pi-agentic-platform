import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };
const AGENT = "atlas-1a2b";

/** An idle task session of an agent whose row names `piPath`. */
async function taskWith(piPath: (papHome: string) => string, agentId: string | null = AGENT) {
  bed = build();
  const { sessionId } = await bed.service.automation.createTaskSession({
    ownerId: "u1",
    cwd: bed.work,
    policy: POLICY,
  });
  bed.service.automation.releaseIdle("u1", sessionId);
  const path = piPath(join(bed.dir, "pap"));
  mkdirSync(join(join(bed.dir, "pap"), "agents", ".mirrors", AGENT), { recursive: true });
  mkdirSync(join(join(bed.dir, "pap"), "agents", ".mirrors", "other-9z9z"), { recursive: true });
  bed.db.run(
    "UPDATE sessions SET pi_path = $path, pi_session_id = 'pi-1', agent_id = $agentId, agent_role = $role WHERE id = $id",
    {
      path,
      agentId,
      role: agentId === null ? null : "task",
      id: sessionId,
    },
  );
  return { sessionId, path };
}
const mirror =
  (agent = AGENT) =>
  (home: string) =>
    join(home, "agents", ".mirrors", agent, "s.jsonl");

describe("deleteTaskSession removes a VM session's mirror (RT-45)", () => {
  it("removes the mirror and its unverified list", async () => {
    const { sessionId, path } = await taskWith(mirror());
    writeFileSync(path, "x\n");
    writeFileSync(`${path}.unverified`, "u1\n");
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.unverified`)).toBe(false);
  });

  it("unlinks a link at the mirror and leaves its target alone", async () => {
    const { sessionId, path } = await taskWith(mirror());
    const target = join(bed.dir, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, path);
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(existsSync(target)).toBe(true);
  });

  it("leaves a file that is not this agent's mirror alone", async () => {
    const { sessionId, path } = await taskWith(mirror("other-9z9z"));
    writeFileSync(path, "x\n");
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(existsSync(path)).toBe(true);
  });
});
