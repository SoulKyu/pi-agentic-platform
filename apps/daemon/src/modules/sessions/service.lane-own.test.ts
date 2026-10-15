import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createLaneHooks, type LaneHooksSlot } from "./lane-hooks.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let slot: LaneHooksSlot;
const bed = () =>
  createServiceBed({
    createSessionsStore,
    createSessionsService: (parts) => {
      slot = createLaneHooks({ clock: parts.clock, logger: silentLogger, infoOf: () => null });
      return createSessionsService({ ...parts, laneHooks: slot });
    },
    loadTranscriptReader,
  });
let current: ReturnType<typeof bed>;
afterEach(() => current.dispose());

/** The folder `foreign` belongs to another owner's lane; every other folder is nobody's or the caller's own. */
const foreignOf = (foreign: string) => (ownerId: string, cwd: string) => {
  if (ownerId !== "owner-b" && cwd.startsWith(foreign)) throw new PapError("forbidden");
};

describe("a session in another owner's lane (Task 8's carry)", () => {
  it("refuses sessions.create with forbidden and starts no worker", async () => {
    current = bed();
    slot.set({
      closed: () => null,
      holdsFiles: () => null,
      beforePrompt: () => undefined,
      afterRun: () => undefined,
      assertOwn: foreignOf(current.otherWork),
    });
    expect(await codeOf(current.service.create(current.otherWork, OWNER))).toBe("forbidden");
    expect(current.spawned).toHaveLength(0);
    // The caller's own folder still opens.
    await expect(current.service.create(current.work, OWNER)).resolves.toMatchObject({});
  });

  it("refuses a reopen of a cold session whose folder is another owner's lane", async () => {
    current = bed();
    const { sessionId } = await current.service.create(current.otherWork, OWNER);
    expect(current.service.releaseIdle(OWNER.userId, sessionId)).toBe("released");
    await current.clock.advance(0);
    slot.set({
      closed: () => null,
      holdsFiles: () => null,
      beforePrompt: () => undefined,
      afterRun: () => undefined,
      assertOwn: foreignOf(current.otherWork),
    });
    const spawned = current.spawned.length;
    expect(await codeOf(current.service.reopen(sessionId, OWNER))).toBe("forbidden");
    expect(await codeOf(current.service.prompt({ sessionId, text: "go" }, OWNER))).toBe("forbidden");
    expect(current.spawned).toHaveLength(spawned);
  });
});
