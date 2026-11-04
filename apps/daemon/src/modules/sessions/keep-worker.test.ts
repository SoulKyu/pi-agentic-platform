import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_RELEASE_MS } from "./idle-release.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const IDLE_MS = 60_000;
const keeping = { value: true };

const build = () =>
  createServiceBed(
    {
      createSessionsStore,
      createSessionsService: (parts) => createSessionsService({ ...parts, keepWorker: () => keeping.value }),
      loadTranscriptReader,
    },
    { idleMs: IDLE_MS },
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const statusOf = (sessionId: string) => bed.service.list(OWNER).find((s) => s.id === sessionId)?.status;

describe("a kept worker (always-on boxes)", () => {
  it("stays live after three idle periods while it is kept", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(3 * IDLE_MS);
    expect(statusOf(sessionId)).toBe("idle");
  });

  it("stays live past the background limit with agent processes left", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({ type: "health", rssMb: 80, descendants: 2 });
    await bed.clock.advance(BACKGROUND_RELEASE_MS + IDLE_MS);
    expect(statusOf(sessionId)).toBe("idle");
  });

  it("is released idleMs after touchIdle once it is no longer kept", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(3 * IDLE_MS);
    keeping.value = false;
    bed.service.touchIdle(OWNER.userId, sessionId);
    await bed.clock.advance(IDLE_MS - 1);
    expect(statusOf(sessionId)).toBe("idle");
    await bed.clock.advance(1);
    expect(statusOf(sessionId)).toBe("cold");
  });

  it("answers released to releaseIdle although the session is kept", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(bed.service.releaseIdle(OWNER.userId, sessionId)).toBe("released");
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("cold");
  });

  it("releaseWhenQuiet releases a kept worker at once when it is quiet", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.service.releaseWhenQuiet(OWNER.userId, sessionId);
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("cold");
  });

  it("releaseWhenQuiet releases a busy kept worker when its run is over, not before", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    bed.emit(0, { type: "agent_start" });
    await bed.clock.advance(0);
    bed.service.releaseWhenQuiet(OWNER.userId, sessionId);
    await bed.clock.advance(3 * IDLE_MS);
    expect(statusOf(sessionId)).toBe("running");
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("cold");
  });

  it("releaseWhenQuiet ignores another owner's session", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.service.releaseWhenQuiet("u2", sessionId);
    await bed.clock.advance(0);
    expect(statusOf(sessionId)).toBe("idle");
  });

  it("releases a session that is not kept at idleMs, as before", async () => {
    keeping.value = false;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(IDLE_MS - 1);
    expect(statusOf(sessionId)).toBe("idle");
    await bed.clock.advance(1);
    expect(statusOf(sessionId)).toBe("cold");
  });

  it("ignores touchIdle for another owner's, a cold or an unknown session", async () => {
    keeping.value = false;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(IDLE_MS - 1);
    bed.service.touchIdle("u2", sessionId);
    bed.service.touchIdle(OWNER.userId, "missing");
    await bed.clock.advance(1);
    expect(statusOf(sessionId)).toBe("cold");
    expect(() => bed.service.touchIdle(OWNER.userId, sessionId)).not.toThrow();
  });
});

describe("a kept worker keeps its quiet time and survives a failing keep", () => {
  it("still reports a quiet-since time (the scan port's reference) while it is kept", async () => {
    keeping.value = true;
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(3 * IDLE_MS);
    const live = bed.service.laneProbe.live.get(sessionId);
    expect(live?.quietSince()).not.toBeNull();
  });

  it("treats a throwing keep as false", async () => {
    bed = createServiceBed(
      {
        createSessionsStore,
        createSessionsService: (parts) =>
          createSessionsService({
            ...parts,
            keepWorker: () => {
              throw new Error("boom");
            },
          }),
        loadTranscriptReader,
      },
      { idleMs: IDLE_MS },
    );
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(IDLE_MS);
    expect(statusOf(sessionId)).toBe("cold");
  });
});
