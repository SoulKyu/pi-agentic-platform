import { type ForkPoint, methods, type TranscriptRow } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fitPoints, sizeOf } from "./snapshot.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { writeWideForkSession } from "./testing/pi-file-writers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
const closeBedAfterEach = () => afterEach(() => bed.dispose());

const choice = (entryId: string, preview = "p") => ({
  entryId,
  preview,
  target: entryId,
  timestamp: null,
  onPath: false,
});
const pointOf = (parentId: string | null, ...ids: string[]): ForkPoint => ({
  parentId,
  choices: ids.map((id) => choice(id)),
});

describe("fitPoints", () => {
  it("keeps what fits as it is", () => {
    const points = [pointOf("a", "b", "c")];
    expect(fitPoints(points, 10_000)).toEqual({ points, truncated: false });
  });

  it("drops the oldest points first, to the byte", () => {
    const points = Array.from({ length: 10 }, (_, i) => pointOf(`n${i}`, `x${i}`, `y${i}`));
    const each = sizeOf(points[0]) + 1;
    const fitted = fitPoints(points, each * 4 + each - 1);
    expect(fitted.points.map((point) => point.parentId)).toEqual(["n6", "n7", "n8", "n9"]);
    expect(fitted.truncated).toBe(true);
  });

  it("skips a choice whose id the contract cannot carry, and a point left with none, saying so", () => {
    const long = "e".repeat(129);
    const fitted = fitPoints(
      [pointOf("a", "b", long), pointOf("c", long, long), pointOf(long, "d", "e"), pointOf("f", "g", "h")],
      10_000,
    );
    expect(fitted.points.map((point) => [point.parentId, point.choices.map((c) => c.entryId)])).toEqual([
      ["a", ["b"]],
      ["f", ["g", "h"]],
    ]);
    expect(fitted.truncated).toBe(true);
    expect(
      fitted.points.every(
        (point) => methods["sessions.branches"].result.shape.points.element.safeParse(point).success,
      ),
    ).toBe(true);
  });

  it("skips a choice whose target is too long", () => {
    const bad = { ...choice("b"), target: "t".repeat(129) };
    const fitted = fitPoints([{ parentId: "a", choices: [bad, choice("c")] }], 10_000);
    expect(fitted.points[0]?.choices.map((c) => c.entryId)).toEqual(["c"]);
    expect(fitted.truncated).toBe(true);
  });
});

describe("sessions.branches under the frame limit", () => {
  closeBedAfterEach();
  it("keeps the newest fork points of a worst-case file under 900 000 JSON bytes, and says it cut", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeWideForkSession(bed.files[0] ?? "", { points: 100, choices: 16, idLength: 120 });
    bed.emit(0, { type: "agent_settled", aborted: false });
    const result = await bed.service.branches(sessionId, OWNER);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(900_000);
    expect(result.truncated).toBe(true);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.length).toBeLessThan(100);
    // The newest points are the ones kept: the last one is the deepest fork of the chain.
    expect(result.points.at(-1)?.parentId).toBe("p98".padEnd(120, "-"));
    expect(methods["sessions.branches"].result.safeParse(result).success).toBe(true);
  });

  it("does not say it cut when nothing was left out", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeWideForkSession(bed.files[0] ?? "", { points: 3, choices: 4, idLength: 20 });
    bed.emit(0, { type: "agent_settled", aborted: false });
    const result = await bed.service.branches(sessionId, OWNER);
    expect(result).toMatchObject({ truncated: false });
    expect(result.points).toHaveLength(3);
  });

  it("answers a valid result for a file whose ids are over 128 characters (the reader already ignores such entries)", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeWideForkSession(bed.files[0] ?? "", { points: 2, choices: 3, idLength: 129 });
    bed.emit(0, { type: "agent_settled", aborted: false });
    const result = await bed.service.branches(sessionId, OWNER);
    expect(result.points).toEqual([]);
    expect(methods["sessions.branches"].result.safeParse(result).success).toBe(true);
  });
});

describe("paging back through rows that were left out", () => {
  closeBedAfterEach();
  it("serves every row once, in order, whatever the JSON escapes cost", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    // 5 characters, 10 JSON bytes (quote, backslash and newline are 2 each, the emoji 4): 200 000 bytes a row.
    const heavy = '"\\\n😀 '.repeat(20_000);
    bed.writePiFile(
      0,
      Array.from({ length: 8 }, (_, i) => [heavy, `r${i}`] as const),
    );
    bed.emit(0, { type: "agent_settled", aborted: false });
    const pages: Array<{ ids: Array<string | null>; hasMore: boolean; turnsBefore: number }> = [];
    let before = "a7";
    for (let guard = 0; guard < 10; guard++) {
      const page = await bed.service.history({ sessionId, before, limit: 100 }, OWNER);
      expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(900_000);
      pages.push({
        ids: page.rows.map((row: TranscriptRow) => row.entryId),
        hasMore: page.hasMore,
        turnsBefore: page.turnsBefore,
      });
      if (!page.hasMore) break;
      before = page.oldestEntryId ?? "";
    }
    expect(pages.map((page) => page.ids.length)).toEqual([8, 7]);
    expect(pages.map((page) => [page.hasMore, page.turnsBefore])).toEqual([
      [true, 4],
      [false, 0],
    ]);
    expect(pages.toReversed().flatMap((page) => page.ids)).toEqual([
      ...["u0", "a0", "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5", "u6", "a6", "u7"],
    ]);
  });
});
