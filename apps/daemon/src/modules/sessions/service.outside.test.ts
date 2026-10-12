import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const flagOf = async (id: string) => ((await bed.snapshot(id)) as { outsideWrite: boolean }).outsideWrite;
const crash = async () => {
  bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
  await bed.clock.advance(0);
};

describe("the service's outside-write wiring (owner Q13)", () => {
  it("ignores a write while the worker is live, and tells one made after the worker ended", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(10_000);
    bed.service.scanPort.touched(sessionId, bed.clock.now() - 1_000, false);
    expect(await flagOf(sessionId)).toBe(false);
    await crash();
    bed.service.scanPort.touched(sessionId, bed.clock.now() - 1, false);
    expect(await flagOf(sessionId)).toBe(false);
    await bed.clock.advance(1_000);
    bed.service.scanPort.touched(sessionId, bed.clock.now(), false);
    expect(await flagOf(sessionId)).toBe(true);
  });

  it("ignores a write while the worker is starting", async () => {
    bed = build({ start: (index) => (index === 0 ? undefined : { kind: "silent" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await crash();
    await bed.clock.advance(1_000);
    const opening = bed.service.prompt({ sessionId, text: "hi" }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    expect(bed.spawned).toHaveLength(2);
    bed.service.scanPort.touched(sessionId, bed.clock.now(), false);
    expect(await flagOf(sessionId)).toBe(false);
    void opening;
  });

  it("does not count the file a fork or a clone made as an outside write", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const file = bed.writePiFile(0, [
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    bed.store.bindPiFile(sessionId, file, "pi-0");
    await bed.clock.advance(10_000);
    const forked = await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    for (const id of [forked.sessionId, cloned.sessionId]) {
      bed.service.scanPort.touched(id, bed.clock.now(), false);
      expect(await flagOf(id)).toBe(false);
    }
    await bed.clock.advance(1_000);
    bed.service.scanPort.touched(cloned.sessionId, bed.clock.now(), false);
    expect(await flagOf(cloned.sessionId)).toBe(true);
  });
});
