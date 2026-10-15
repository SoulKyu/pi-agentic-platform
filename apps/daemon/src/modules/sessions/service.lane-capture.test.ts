import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createSessionsLanePort } from "./lane-port.ts";
import { createLaneHooks, type LaneHooksSlot, type LaneRunHooks } from "./lane-hooks.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let slot: LaneHooksSlot;
const build = (options: BedOptions = {}) =>
  createServiceBed(
    {
      createSessionsStore,
      createSessionsService: (parts) => {
        slot = createLaneHooks({
          clock: parts.clock,
          logger: silentLogger,
          infoOf: (sessionId) => {
            const row = parts.store.get(sessionId);
            return row ? { ownerId: row.ownerId, sessionId, cwd: row.cwd, leafId: null } : null;
          },
        });
        return createSessionsService({ ...parts, laneHooks: slot });
      },
      loadTranscriptReader,
    },
    options,
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const hooks = (over: Partial<LaneRunHooks>): LaneRunHooks => ({
  closed: () => null,
  holdsFiles: () => null,
  beforePrompt: () => undefined,
  afterRun: () => undefined,
  ...over,
});
const codeOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "sent",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

/** A session whose "before" capture is held open; `release()` lets the prompt go. */
async function held() {
  bed = build();
  let release!: () => void;
  slot.set(hooks({ beforePrompt: () => new Promise<void>((resolve) => (release = resolve)) }));
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const sent = bed.service.prompt({ sessionId, text: "go", streamingBehavior: "followUp" }, OWNER);
  await bed.clock.advance(0);
  return { sessionId, sent, release: () => release() };
}
const requests = () => bed.spawned[0]?.requests.map((request) => request.type) ?? [];

describe("the 'before' capture window of a lane prompt (task 6a carry, M9R114)", () => {
  it("refuses a compaction during the capture, and sends it nothing", async () => {
    const { sessionId, sent, release } = await held();
    expect(await codeOf(bed.service.compact({ sessionId }, OWNER))).toBe("session_busy");
    expect(requests()).not.toContain("compact");
    release();
    await sent;
  });

  it("reports the automation port's promptPending while the capture holds the prompt (M10 on M9)", async () => {
    const { sessionId, sent, release } = await held();
    expect(bed.service.automation.promptPending(OWNER.userId, sessionId)).toBe(true);
    release();
    await sent;
  });

  it("refuses a navigation during the capture", async () => {
    const { sessionId, sent, release } = await held();
    expect(await codeOf(bed.service.navigate({ sessionId, targetId: "x" }, OWNER))).toBe("session_busy");
    expect(requests()).not.toContain("navigate_tree");
    release();
    await sent;
  });

  it("refuses setModel and setTools during the capture", async () => {
    const { sessionId, sent, release } = await held();
    expect(
      await codeOf(bed.service.setModel({ sessionId, provider: "scripted", modelId: "scripted" }, OWNER)),
    ).toBe("session_busy");
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "read-only" }, OWNER))).toBe(
      "session_busy",
    );
    expect(requests()).not.toContain("set_model");
    expect(requests()).not.toContain("set_tools");
    release();
    await sent;
  });

  it("leaves the worker alone on a trust restart during the capture, and releases it after the run", async () => {
    const { sessionId, sent, release } = await held();
    expect(bed.service.restartFolder(OWNER.userId, bed.work)).toBe(1);
    await bed.clock.advance(0);
    expect(bed.spawned[0]?.stopped()).toBe(false);
    release();
    await sent;
    bed.emit(0, { type: "agent_start" });
    await bed.clock.advance(0);
    bed.emit(0, { type: "agent_settled" });
    await bed.clock.advance(500);
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(bed.service.list(OWNER).find((s) => s.id === sessionId)?.status).toBe("cold");
  });

  it("shows the folder busy to the lane port during the hold, so an archive that starts then is refused", async () => {
    const { sessionId, sent, release } = await held();
    const port = createSessionsLanePort({
      service: bed.service,
      store: bed.store,
      marks: bed.store.marks,
      probe: bed.service.laneProbe,
      waiting: slot.waiting,
      logger: silentLogger,
    });
    expect(port.activityIn(OWNER.userId, bed.work).busy).toBe(true);
    expect(port.runState(OWNER.userId, sessionId).idle).toBe(false);
    // The capture's own re-check counts the waiting prompt as its own.
    expect(port.runState(OWNER.userId, sessionId, { ownPrompt: true }).idle).toBe(true);
    release();
    await sent;
  });
});
