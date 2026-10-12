import { appendFileSync } from "node:fs";
import { ALL_PERMISSIONS, type Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const build = (options?: Parameters<typeof createServiceBed>[1]) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

type Snapshot = {
  rows: Array<{ entryId: string | null; message: { role: string; content: unknown } }>;
  leafId: string | null;
  history: { hasMore: boolean; oldestEntryId: string | null; turnsBefore: number };
};
const snap = async () => (await bed.snapshot("p1")) as unknown as Snapshot;
const texts = (snapshot: Snapshot) =>
  snapshot.rows.map(({ message: m }) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
const entryLine = (id: string, parentId: string, content: string) =>
  `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-10T00:00:05.000Z", message: { role: "user", content, timestamp: 4 } })}\n`;

describe("the snapshot follows the worker's leaf", () => {
  // The file ends on a sibling branch ("alt"), but Pi's leaf is a1.
  async function twoBranches() {
    bed = build({ start: () => ({ kind: "ready", leafId: "a1" }) });
    await bed.service.create(bed.work, owner);
    const file = bed.writePiFile(0, [
      ["first", "one"],
      ["second", "two"],
    ]);
    appendFileSync(file, entryLine("alt", "a0", "alt"));
    return file;
  }

  it("reads the branch that ends at the leaf the run began at, up to the baseline, then the run's rows with the ids bound so far", async () => {
    const file = await twoBranches();
    bed.emit(0, { type: "agent_start" });
    expect(texts(await snap())).toEqual([
      "first",
      '[{"type":"text","text":"one"}]',
      "second",
      '[{"type":"text","text":"two"}]',
    ]);
    const third = { role: "user", content: "third", timestamp: 9 };
    bed.emit(0, { type: "message_end", message: third });
    let snapshot = await snap();
    expect(snapshot.rows.at(-1)).toEqual({ entryId: null, message: third });
    expect(snapshot.leafId).toBe("a1");
    // Pi's file gets the entry after the event; the snapshot must not show it twice, and must not follow it to a sibling.
    appendFileSync(file, entryLine("u2", "a1", "third"));
    bed.emit(0, {
      type: "entry_appended",
      entry: { id: "u2", parentId: "a1", type: "message", role: "user", messageTimestamp: 9 },
    });
    snapshot = await snap();
    expect(texts(snapshot)).toEqual([
      "first",
      '[{"type":"text","text":"one"}]',
      "second",
      '[{"type":"text","text":"two"}]',
      "third",
    ]);
    expect(snapshot.rows.at(-1)?.entryId).toBe("u2");
    expect(snapshot.leafId).toBe("u2");
  });

  it("reads along the leaf once the run has settled, and along a leaf the worker moved", async () => {
    await twoBranches();
    expect(texts(await snap()).slice(-2)).toEqual(["second", '[{"type":"text","text":"two"}]']);
    bed.spawned[0]?.emit({ type: "leaf", leafId: "alt", resync: false });
    const snapshot = await snap();
    expect(texts(snapshot)).toEqual(["first", '[{"type":"text","text":"one"}]', "alt"]);
    expect(snapshot.leafId).toBe("alt");
  });

  it("follows the file's last entry when the leaf is unknown (M2R4)", async () => {
    bed = build({ start: () => ({ kind: "ready", leafId: "x".repeat(129) }) });
    await bed.service.create(bed.work, owner);
    appendFileSync(bed.writePiFile(0, [["first", "one"]]), entryLine("alt", "a0", "alt"));
    const snapshot = await snap();
    expect(texts(snapshot).at(-1)).toBe("alt");
    expect(snapshot.leafId).toBe("alt");
  });

  it("shows the compaction of a run as a row with its id", async () => {
    await twoBranches();
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, {
      type: "entry_appended",
      entry: {
        id: "c1",
        parentId: "a1",
        type: "compaction",
        timestamp: "2026-10-10T00:00:06.000Z",
        summary: "S",
        tokensBefore: 3,
      },
    });
    const snapshot = await snap();
    expect(snapshot.rows.at(-1)).toEqual({
      entryId: "c1",
      message: {
        role: "compactionSummary",
        summary: "S",
        tokensBefore: 3,
        timestamp: Date.parse("2026-10-10T00:00:06.000Z"),
      },
    });
  });
});

describe("history when the snapshot leaves rows out", () => {
  it("points at the oldest row kept and counts the turns left out, when the run's rows push the file's out", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.writePiFile(
      0,
      Array.from({ length: 100 }, (_, i) => [`question ${i}`, `answer ${i}`] as const),
    );
    bed.emit(0, { type: "agent_start" });
    for (let n = 0; n < 3; n++)
      bed.emit(0, { type: "message_end", message: { role: "user", content: `run ${n}`, timestamp: n } });
    const snapshot = await snap();
    expect(snapshot.rows).toHaveLength(75);
    expect(snapshot.rows[0]?.entryId).toBe("u64");
    expect(snapshot.history).toEqual({ hasMore: true, oldestEntryId: "u64", turnsBefore: 64 });
  });
});
