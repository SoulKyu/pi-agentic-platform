import { afterEach, describe, expect, it } from "vitest";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };

describe("admits (M10R105: a resume defers at capacity before its point of no return)", () => {
  it("is true for a warm session, whatever the cap", async () => {
    bed = build({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(bed.service.automation.admits(OWNER.userId, sessionId)).toBe(true);
  });

  it("is true for a cold session only while a worker stays free for the owner", async () => {
    bed = build({ limits: { maxWorkers: 3, minFreeMemMb: 0 } });
    const { sessionId } = await bed.service.automation.createTaskSession({
      ownerId: OWNER.userId,
      cwd: bed.work,
      policy: POLICY,
    });
    bed.service.automation.releaseIdle(OWNER.userId, sessionId);
    await bed.clock.advance(0);
    expect(bed.service.automation.admits(OWNER.userId, sessionId)).toBe(true);
    await bed.service.create(bed.work, OWNER);
    expect(bed.service.automation.admits(OWNER.userId, sessionId)).toBe(true);
    await bed.service.create(bed.work, OWNER);
    expect(bed.service.automation.admits(OWNER.userId, sessionId)).toBe(false);
    // The same answer the prompt gives, so the handler's deferral and the port never disagree.
    expect(await codeOf(bed.service.automation.prompt({ ownerId: OWNER.userId, sessionId, text: "x" }))).toBe(
      "capacity",
    );
  });

  it("is false for a cold session under the free-memory floor, true for a warm one (I4)", async () => {
    const limits = { maxWorkers: 4, minFreeMemMb: 0 };
    bed = build({ limits, freeMemMb: 100 });
    const warm = await bed.service.automation.createTaskSession({
      ownerId: OWNER.userId,
      cwd: bed.work,
      policy: POLICY,
    });
    expect(bed.service.automation.admits(OWNER.userId, warm.sessionId)).toBe(true);
    bed.service.automation.releaseIdle(OWNER.userId, warm.sessionId);
    limits.minFreeMemMb = 512;
    expect(bed.service.automation.admits(OWNER.userId, warm.sessionId)).toBe(false);
    expect(
      await codeOf(
        bed.service.automation.prompt({ ownerId: OWNER.userId, sessionId: warm.sessionId, text: "x" }),
      ),
    ).toBe("capacity");
  });

  it("reports a reopen and a prompt in flight, and nothing for a quiet session (I1)", async () => {
    bed = build({ limits: { maxWorkers: 4, minFreeMemMb: 0 } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(bed.service.automation.promptPending(OWNER.userId, sessionId)).toBe(false);
    bed.service.automation.releaseIdle(OWNER.userId, sessionId);
    await bed.clock.advance(0);
    expect(bed.service.automation.promptPending(OWNER.userId, sessionId)).toBe(false);
    const reopening = bed.service.automation.prompt({ ownerId: OWNER.userId, sessionId, text: "x" });
    expect(bed.service.automation.promptPending(OWNER.userId, sessionId)).toBe(true);
    await reopening;
    expect(() => bed.service.automation.promptPending("u2", sessionId)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("answers not_found for another owner's session", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(() => bed.service.automation.admits("u2", sessionId)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
