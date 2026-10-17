import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed?.dispose());

const model = { provider: "faux", id: "plain", name: "Plain", reasoning: false };
const promptDir = () => join(bed.dir, "pap", "subagents");
const promptOf = (id: string) => join(promptDir(), `${id}.prompt`);

async function parentWithChild() {
  bed = build({ limits: { maxWorkers: 10, minFreeMemMb: 0 }, replies: { set_model: {} } });
  const parent = await bed.service.create(bed.work, OWNER);
  bed.spawned[0]?.emitRaw({
    type: "loadout",
    loadout: {
      model,
      thinkingLevel: "off",
      levels: ["off"],
      preset: "configured",
      tools: ["read"],
      toolsTruncated: false,
    },
  });
  const child = await bed.service.child.createChildSession({
    ownerId: "u1",
    parentSessionId: parent.sessionId,
    profile: { tools: null, prompt: "You scout.", model: null },
  });
  return { parent: parent.sessionId, child: child.sessionId };
}

describe("a parent that is archived or deleted (M11R139 c)", () => {
  it("tells the listeners once when the parent is archived, and not for an unarchive or another change", async () => {
    const { parent } = await parentWithChild();
    const heard: Array<[string, string]> = [];
    const off = bed.service.child.onGone((sessionId, why) => void heard.push([sessionId, why]));
    bed.service.mark({ sessionId: parent, change: { kind: "pin", before: null } }, OWNER);
    expect(heard).toEqual([]);
    bed.service.mark({ sessionId: parent, change: { kind: "archive" } }, OWNER);
    expect(heard).toEqual([[parent, "archived"]]);
    off();
    bed.service.mark({ sessionId: parent, change: { kind: "unarchive" } }, OWNER);
    bed.service.mark({ sessionId: parent, change: { kind: "archive" } }, OWNER);
    expect(heard).toHaveLength(1);
  });

  it("tells the listeners when a session is deleted", async () => {
    const { child } = await parentWithChild();
    const heard: Array<[string, string]> = [];
    bed.service.child.onGone((sessionId, why) => void heard.push([sessionId, why]));
    expect(bed.service.releaseIdle("u1", child)).toBe("released");
    await bed.clock.advance(0);
    expect(bed.service.automation.deleteTaskSession("u1", child)).toBe("deleted");
    expect(heard).toEqual([[child, "deleted"]]);
  });

  it("keeps a listener that throws from stopping the others or the archive", async () => {
    const { parent } = await parentWithChild();
    const heard: string[] = [];
    bed.service.child.onGone(() => {
      throw new Error("boom");
    });
    bed.service.child.onGone((sessionId) => void heard.push(sessionId));
    bed.service.mark({ sessionId: parent, change: { kind: "archive" } }, OWNER);
    expect(heard).toEqual([parent]);
  });
});

describe("a child's prompt file (W5-R62)", () => {
  it("stays when the child is only archived (an archive is reversible)", async () => {
    const { child } = await parentWithChild();
    bed.service.mark({ sessionId: child, change: { kind: "archive" } }, OWNER);
    expect(existsSync(promptOf(child))).toBe(true);
  });

  it("goes when the child session is deleted", async () => {
    const { child } = await parentWithChild();
    expect(existsSync(promptOf(child))).toBe(true);
    expect(bed.service.releaseIdle("u1", child)).toBe("released");
    await bed.clock.advance(0);
    expect(bed.service.automation.deleteTaskSession("u1", child)).toBe("deleted");
    expect(existsSync(promptOf(child))).toBe(false);
  });

  it("is swept at boot when no session row has it, and kept for a row that exists", async () => {
    const { child } = await parentWithChild();
    writeFileSync(promptOf("orphan-1"), "left behind");
    writeFileSync(promptOf("orphan-2"), "");
    writeFileSync(join(promptDir(), "notes.txt"), "not a prompt");
    expect(bed.service.child.sweepPrompts()).toBe(2);
    expect(readdirSync(promptDir()).toSorted()).toEqual([`${child}.prompt`, "notes.txt"].toSorted());
  });

  it("sweeps nothing when the folder does not exist", () => {
    bed = build();
    expect(bed.service.child.sweepPrompts()).toBe(0);
  });
});

describe("parentOpen (review M1)", () => {
  it("is true for the owner's open session, false once it is archived, for another owner and for a session that is gone", async () => {
    const { parent } = await parentWithChild();
    expect(bed.service.child.parentOpen("u1", parent)).toBe(true);
    expect(bed.service.child.parentOpen("u2", parent)).toBe(false);
    expect(bed.service.child.parentOpen("u1", "ghost")).toBe(false);
    bed.service.mark({ sessionId: parent, change: { kind: "archive" } }, OWNER);
    expect(bed.service.child.parentOpen("u1", parent)).toBe(false);
    bed.service.mark({ sessionId: parent, change: { kind: "unarchive" } }, OWNER);
    expect(bed.service.child.parentOpen("u1", parent)).toBe(true);
  });
});
