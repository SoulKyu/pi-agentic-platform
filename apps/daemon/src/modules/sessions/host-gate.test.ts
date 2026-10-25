import { afterEach, describe, expect, it } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const BOX = "/boxes/p1/project";
const boxes = createFakeProjectBoxSource({
  p1: {
    ownerId: "u1",
    root: BOX,
    resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
    hosts: [],
    deleting: false,
  },
});
let member = true;
const build = (options: BedOptions = {}) =>
  createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { isMember: () => member, boxes, ...options },
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

describe("a member's sessions are in a box (M14)", () => {
  it("sessions.create on a host folder is forbidden before any realpath and starts no worker", async () => {
    member = true;
    bed = build();
    // A folder that does not exist: a host check would say invalid_cwd, so `forbidden` proves the host was not asked.
    expect(await codeOf(bed.service.create("/does/not/exist", OWNER))).toBe("forbidden");
    expect(await codeOf(bed.service.create(bed.work, OWNER))).toBe("forbidden");
    expect(bed.spawned).toHaveLength(0);
  });

  it("a trigger task on a host folder is forbidden before any row", async () => {
    member = true;
    bed = build();
    const policy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: false } as const;
    const made = bed.service.automation.createTaskSession({
      ownerId: "u1",
      cwd: bed.work,
      policy,
    } as never);
    expect(await codeOf(Promise.resolve().then(() => made))).toBe("forbidden");
    expect(bed.spawned).toHaveLength(0);
  });

  it("a host row of a member never launches a host worker, even when it was stored before", async () => {
    member = false;
    bed = build({ idleMs: 1000, holdShutdown: true, start: () => ({ kind: "ready", leafId: "a1" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(1000);
    bed.spawned[0]?.crash({ code: 0, signal: null, cause: "clean" });
    expect(bed.spawned).toHaveLength(1);
    member = true;
    expect(await codeOf(bed.service.reopen(sessionId, OWNER))).toBe("forbidden");
    expect(bed.spawned).toHaveLength(1);
  });

  it("a deleted member's stored host row never launches a host worker", async () => {
    const owners = new Set(["u1"]);
    member = false;
    bed = build({
      idleMs: 1000,
      holdShutdown: true,
      start: () => ({ kind: "ready", leafId: "a1" }),
      isMember: (id) => !owners.has(id),
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.clock.advance(1000);
    bed.spawned[0]?.crash({ code: 0, signal: null, cause: "clean" });
    owners.clear();
    expect(await codeOf(bed.service.reopen(sessionId, OWNER))).toBe("forbidden");
    expect(bed.spawned).toHaveLength(1);
  });

  it("the owner is never gated", async () => {
    member = false;
    bed = build();
    await bed.service.create(bed.work, OWNER);
    expect(bed.spawned).toHaveLength(1);
  });
});
