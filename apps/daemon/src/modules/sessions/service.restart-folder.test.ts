import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const statusOf = (sessionId: string) =>
  bed.service.list(OWNER).find((summary) => summary.id === sessionId)?.status;
const stoppedWorkers = () => bed.spawned.filter((worker) => worker.stopped()).length;

// A decision of the trust store applies at the next open of a worker (M7R105): the service lets go of the workers in the folder.
describe("restartFolder (M7R105)", () => {
  it("releases the idle workers in the folder and below at once, and no other", async () => {
    bed = build();
    const below = join(bed.work, "sub");
    mkdirSync(below);
    const inside = (await bed.service.create(bed.work, OWNER)).sessionId;
    const nested = (await bed.service.create(below, OWNER)).sessionId;
    const elsewhere = (await bed.service.create(bed.otherWork, OWNER)).sessionId;
    expect(bed.service.restartFolder(OWNER.userId, bed.work)).toBe(2);
    await bed.clock.advance(0);
    expect([statusOf(inside), statusOf(nested), statusOf(elsewhere)]).toEqual(["cold", "cold", "idle"]);
  });

  it("matches whole folders only: a sibling that shares a name prefix stays", async () => {
    bed = build();
    const sibling = `${bed.work}-twin`;
    mkdirSync(sibling);
    const twin = (await bed.service.create(sibling, OWNER)).sessionId;
    expect(bed.service.restartFolder(OWNER.userId, bed.work)).toBe(0);
    expect(statusOf(twin)).toBe("idle");
  });

  it("leaves another owner's workers alone", async () => {
    bed = build();
    const mine = (await bed.service.create(bed.work, OWNER)).sessionId;
    expect(bed.service.restartFolder(testCaller({ userId: "u2" }).userId, bed.work)).toBe(0);
    expect(statusOf(mine)).toBe("idle");
    expect(stoppedWorkers()).toBe(0);
  });

  it("lets a running worker finish its run, then releases it", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    bed.emit(0, { type: "agent_start" });
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("running");
    expect(bed.service.restartFolder(OWNER.userId, bed.work)).toBe(1);
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("running");
    expect(stoppedWorkers()).toBe(0);
    bed.emit(0, { type: "agent_settled" });
    await bed.clock.advance(500);
    expect(statusOf(sessionId)).toBe("cold");
    expect(stoppedWorkers()).toBe(1);
  });

  it("starts a new worker with the next prompt, in the same folder", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.service.restartFolder(OWNER.userId, bed.work);
    await bed.clock.advance(0);
    await bed.service.prompt({ sessionId, text: "again" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(statusOf(sessionId)).toBe("idle");
  });

  it("lets the prompt that started a worker run when a decision lands during the start, then releases it (M7R105)", async () => {
    bed = build({ start: (index) => (index === 1 ? { kind: "silent" } : { kind: "ready" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.service.restartFolder(OWNER.userId, bed.work);
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("cold");
    const prompt = bed.service.prompt({ sessionId, text: "again" }, OWNER);
    await bed.clock.advance(0);
    expect(bed.spawned).toHaveLength(2);
    expect(bed.service.restartFolder(OWNER.userId, bed.work)).toBe(1);
    bed.spawned[1]?.emit({
      type: "ready",
      sessionId: "pi-1",
      sessionFile: "/x/pi-1.jsonl",
      piVersion: "1.1.0",
      leafId: null,
      sessionName: null,
    });
    await expect(prompt).resolves.toBeDefined();
    await bed.clock.advance(0);
    expect(bed.spawned[1]?.stopped()).toBe(false);
    bed.emit(1, { type: "agent_start" });
    await bed.clock.advance(0);
    bed.emit(1, { type: "agent_settled" });
    await bed.clock.advance(500);
    expect(bed.spawned[1]?.stopped()).toBe(true);
    expect(statusOf(sessionId)).toBe("cold");
  });
});
