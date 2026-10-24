import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };
const projectOf = (sessionId: string) =>
  bed.db.get<{ projectId: string }>("SELECT project_id AS projectId FROM sessions WHERE id = $sessionId", {
    sessionId,
  })?.projectId ?? "";

async function session(index: number, keep: boolean) {
  const { sessionId } = await bed.service.automation.createTaskSession({
    ownerId: "u1",
    cwd: bed.work,
    policy: POLICY,
  });
  const file = bed.writePiFile(index);
  bed.store.bindPiFile(sessionId, file, `pi-${index}`);
  if (!keep) bed.service.automation.releaseIdle("u1", sessionId);
  return { sessionId, file };
}

describe("projectCleanup (boxes B1)", () => {
  it("counts the project's sessions, and removes the live and the idle ones and touches no file", async () => {
    bed = build();
    const idle = await session(0, false);
    const live = await session(1, true);
    const projectId = projectOf(idle.sessionId);
    expect(projectOf(live.sessionId)).toBe(projectId);
    const port = bed.service.projectCleanup;
    expect(port.count("u1", projectId)).toBe(2);
    expect(port.count("u2", projectId)).toBe(0);
    expect(port.liveIds("u1", projectId)).toEqual([live.sessionId]);
    expect(port.liveIds("u2", projectId)).toEqual([]);
    expect(await port.removeProject("u1", projectId)).toEqual({ sessions: 2 });
    expect(bed.store.get(idle.sessionId)).toBeUndefined();
    expect(bed.store.get(live.sessionId)).toBeUndefined();
    // The box moved its files to the trash; the port never reaches for a file one by one.
    expect(existsSync(idle.file)).toBe(true);
    expect(existsSync(live.file)).toBe(true);
    expect(port.count("u1", projectId)).toBe(0);
  });

  it("leaves another owner's sessions and other projects alone", async () => {
    bed = build();
    const mine = await session(0, false);
    const projectId = projectOf(mine.sessionId);
    expect(await bed.service.projectCleanup.removeProject("u2", projectId)).toEqual({ sessions: 0 });
    expect(await bed.service.projectCleanup.removeProject("u1", "p:other")).toEqual({ sessions: 0 });
    expect(bed.store.get(mine.sessionId)).toBeDefined();
    expect(existsSync(mine.file)).toBe(true);
  });
});
