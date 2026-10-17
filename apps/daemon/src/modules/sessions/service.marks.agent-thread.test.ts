import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, NO_MARKS } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const OWNER = testCaller();
let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

async function threadAndPlain() {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }
          : null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  const thread = (
    await bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" })
  ).sessionId;
  const plain = (await bed.service.create(bed.work, OWNER)).sessionId;
  return { thread, plain };
}

describe("a pinned agent thread and the sidebar's pin slots", () => {
  it("is pinned without joining the owner's pins, and a later pin or unpin of a session leaves it pinned", async () => {
    const { thread, plain } = await threadAndPlain();
    const other = (await bed.service.create(bed.work, OWNER)).sessionId;
    bed.service.mark({ sessionId: other, change: { kind: "pin", before: null } }, OWNER);
    bed.service.mark({ sessionId: thread, change: { kind: "pin", before: null } }, OWNER);
    expect(bed.store.marks.row(thread)?.marks.pinRank).toBe(1);
    expect(bed.store.marks.pins("u1")).toEqual([other]);
    bed.service.mark({ sessionId: plain, change: { kind: "pin", before: null } }, OWNER);
    expect(bed.store.marks.pins("u1")).toEqual([other, plain]);
    expect(bed.store.marks.row(thread)?.marks.pinRank).toBe(1);
    bed.service.mark({ sessionId: plain, change: { kind: "unpin" } }, OWNER);
    expect(bed.store.marks.pins("u1")).toEqual([other]);
    expect(bed.store.marks.row(thread)?.marks.pinRank).toBe(1);
    bed.service.mark({ sessionId: thread, change: { kind: "unpin" } }, OWNER);
    expect(bed.store.marks.row(thread)?.marks.pinRank).toBeNull();
  });

  it("does not use one of the 50 slots", async () => {
    const { thread, plain } = await threadAndPlain();
    bed.service.mark({ sessionId: thread, change: { kind: "pin", before: null } }, OWNER);
    const projectId = bed.store.marks.row(plain)?.projectId ?? null;
    const seeded: string[] = [];
    bed.db.transaction(() => {
      for (let i = 0; i < 49; i++) {
        const id = `seed${i}`;
        bed.store.insert(
          {
            id,
            piPath: null,
            piSessionId: null,
            cwd: "/w",
            ownerId: "u1",
            name: null,
            createdAt: 1,
            updatedAt: 1,
          },
          projectId,
        );
        seeded.push(id);
      }
      for (const id of seeded) bed.store.marks.write(id, NO_MARKS, null);
      bed.store.marks.write("seed0", NO_MARKS, { ownerId: "u1", order: seeded });
    });
    // 49 pins and a pinned agent thread: the 50th pin still fits.
    bed.service.mark({ sessionId: plain, change: { kind: "pin", before: null } }, OWNER);
    expect(bed.store.marks.pins("u1")).toHaveLength(50);
  });
});
