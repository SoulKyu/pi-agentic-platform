import { ALL_PERMISSIONS, type Caller, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const stranger: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const clearsSent = () => bed.spawned[0]?.requests.filter((request) => request.type === "clear_queue").length;

describe("clearQueue", () => {
  it("asks the live worker and returns what was waiting", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    expect(await bed.service.clearQueue("p1", owner)).toEqual({
      steering: ["left"],
      followUp: ["after"],
      truncated: false,
    });
    expect(clearsSent()).toBe(1);
  });

  it("answers empty lists for a cold session, without starting a worker", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(await bed.service.clearQueue("p1", owner)).toEqual({
      steering: [],
      followUp: [],
      truncated: false,
    });
    expect(bed.spawned).toHaveLength(1);
    expect(clearsSent()).toBe(0);
  });

  it("is the owner's: a stranger and an unknown session get not_found, and no worker hears of it", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    await expect(bed.service.clearQueue("p1", stranger)).rejects.toThrow(new PapError("not_found"));
    await expect(bed.service.clearQueue("nope", owner)).rejects.toThrow(new PapError("not_found"));
    expect(clearsSent()).toBe(0);
  });
});

describe("the queue in the snapshot", () => {
  it("shows what Pi last said it holds, and nothing after the worker is gone", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "queue_update", steering: ["left"], followUp: [], count: 1, bytes: 4 });
    expect(await bed.snapshot("p1")).toMatchObject({
      queue: { steering: ["left"], followUp: [], count: 1, bytes: 4 },
    });
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(await bed.snapshot("p1")).toMatchObject({
      queue: { steering: [], followUp: [], count: 0, bytes: 0 },
    });
  });
});
