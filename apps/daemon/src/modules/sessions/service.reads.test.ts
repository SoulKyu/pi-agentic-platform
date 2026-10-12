import { appendFileSync } from "node:fs";
import { ALL_PERMISSIONS, type Caller, PapError, type TranscriptRow } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clipJsonText } from "./service-reads.ts";
import { createSessionsService } from "./service.ts";
import { fitPage } from "./snapshot.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { writeForkedSession, writeRepeatedToolSession, writeToolSession } from "./testing/pi-file-writers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const OTHER: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
const closeBedAfterEach = () => afterEach(() => bed.dispose());

const open = () => {
  bed = build();
};

const said = (row: TranscriptRow) => {
  const content = (row.message as { content: unknown }).content;
  return typeof content === "string" ? content : (content as Array<{ text: string }>)[0]?.text;
};

describe("sessions.history", () => {
  closeBedAfterEach();
  it("pages older rows from a cursor, newest last, and says when the start is reached", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const exchanges = Array.from({ length: 45 }, (_, i) => [`q${i}`, `r${i}`] as const);
    bed.writePiFile(0, exchanges);
    bed.emit(0, { type: "agent_settled", aborted: false });
    const snapshot = await bed.snapshot(sessionId);
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    // 90 rows: the snapshot keeps the newest 75, which start at r7 (entry a7).
    expect(snapshot.rows).toHaveLength(75);
    expect(snapshot.history).toEqual({ hasMore: true, oldestEntryId: "a7", turnsBefore: 8 });
    const page = await bed.service.history({ sessionId, before: "a7", limit: 50 }, OWNER);
    expect(page.rows.map(said)).toEqual([
      ...["q0", "r0", "q1", "r1", "q2", "r2", "q3", "r3", "q4", "r4", "q5", "r5", "q6", "r6", "q7"],
    ]);
    // The walk reached the system prompt's entry (shown as nothing): that is the oldest entry it read.
    expect(page).toMatchObject({ hasMore: false, oldestEntryId: "s0", turnsBefore: 0 });
  });

  it("defaults to 50 rows and answers a page of a session that has no file yet with nothing", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.history({ sessionId, before: "a7" }, OWNER)).toEqual({
      rows: [],
      hasMore: false,
      oldestEntryId: null,
      turnsBefore: 0,
    });
    bed.writePiFile(
      0,
      Array.from({ length: 45 }, (_, i) => [`q${i}`, `r${i}`] as const),
    );
    bed.emit(0, { type: "agent_settled", aborted: false });
    const page = await bed.service.history({ sessionId, before: "a44" }, OWNER);
    expect(page.rows).toHaveLength(50);
  });

  it("keeps a page under 900 000 JSON bytes: its oldest rows go and the cursor follows", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const big = "x".repeat(200_000);
    bed.writePiFile(
      0,
      Array.from({ length: 6 }, (_, i) => [big, `r${i}`] as const),
    );
    bed.emit(0, { type: "agent_settled", aborted: false });
    const page = await bed.service.history({ sessionId, before: "a5", limit: 100 }, OWNER);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(900_000 + 1000);
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(900_000);
    // Four 200 000-byte rows and the four small ones among them fit; the fifth big row does not.
    expect(page.rows.map((row) => row.entryId)).toEqual(["a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5"]);
    expect(page).toMatchObject({ hasMore: true, oldestEntryId: "a1", turnsBefore: 2 });
  });
});

describe("sessions.toolOutput", () => {
  closeBedAfterEach();
  it("gives a tool's whole output and its arguments, bounded, and not_found for an unknown call", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeToolSession(bed.files[0] ?? "", "c1", "x".repeat(1_000_000));
    bed.emit(0, { type: "agent_settled", aborted: false });
    const output = await bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER);
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output.text))).toBeLessThanOrEqual(800_000);
    expect(output.isError).toBe(false);
    expect(output.args).toBe(JSON.stringify({ path: "big.txt" }));
    await expect(bed.service.toolOutput({ sessionId, toolCallId: "nope" }, OWNER)).rejects.toThrow(PapError);
  });

  it("gives an output that fits whole, untruncated", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeToolSession(bed.files[0] ?? "", "c1", "line\n".repeat(30_000));
    bed.emit(0, { type: "agent_settled", aborted: false });
    const output = await bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER);
    expect(output.truncated).toBe(false);
    expect(output.text).toBe("line\n".repeat(30_000));
  });

  it("finds a call on the session's active branch only", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeToolSession(bed.files[0] ?? "", "c1", "out");
    bed.emit(0, { type: "agent_settled", aborted: false });
    expect((await bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER)).text).toBe("out");
    // A new user message under u0 starts another branch: the call is on the abandoned one now.
    const entry = { type: "message", id: "u9", parentId: "u0", timestamp: "2026-10-10T00:00:09.000Z" };
    appendFileSync(
      bed.files[0] ?? "",
      `${JSON.stringify({ ...entry, message: { role: "user", content: "again", timestamp: 9 } })}\n`,
    );
    expect(await codeOf(bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER))).toBe("not_found");
  });

  it("gives each turn its own output and arguments when a provider reuses the call id", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeRepeatedToolSession(bed.files[0] ?? "", "call_0");
    bed.emit(0, { type: "agent_settled", aborted: false });
    const ask = (resultEntryId?: string) =>
      bed.service.toolOutput(
        { sessionId, toolCallId: "call_0", ...(resultEntryId ? { resultEntryId } : {}) },
        OWNER,
      );
    const pick = ({ text, args }: { text: string; args: string | null }) => [text, args];
    expect(pick(await ask("t0"))).toEqual(["first", JSON.stringify({ path: "one.txt" })]);
    expect(pick(await ask("t1"))).toEqual(["second", JSON.stringify({ path: "two.txt" })]);
    // Without an entry (a live row that Pi has not written yet) the newest call answers.
    expect(pick(await ask())).toEqual(["second", JSON.stringify({ path: "two.txt" })]);
  });

  it("is not_found for an entry that is not the result of that call on the active branch", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeRepeatedToolSession(bed.files[0] ?? "", "call_0");
    bed.emit(0, { type: "agent_settled", aborted: false });
    const ask = (toolCallId: string, resultEntryId: string) =>
      codeOf(bed.service.toolOutput({ sessionId, toolCallId, resultEntryId }, OWNER));
    expect(await ask("call_0", "nope")).toBe("not_found");
    expect(await ask("call_0", "a0")).toBe("not_found");
    expect(await ask("other", "t0")).toBe("not_found");
    // An entry on an abandoned branch is not found either.
    const entry = { type: "message", id: "u9", parentId: "u0", timestamp: "2026-10-10T00:00:09.000Z" };
    appendFileSync(
      bed.files[0] ?? "",
      `${JSON.stringify({ ...entry, message: { role: "user", content: "again", timestamp: 9 } })}\n`,
    );
    expect(await ask("call_0", "t1")).toBe("not_found");
  });

  it("is not_found for a session that has no file yet", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER))).toBe("not_found");
  });
});

describe("sessions.branches", () => {
  closeBedAfterEach();
  it("lists the fork points of the active branch", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeForkedSession(bed.files[0] ?? ""); // a0 has two user children u1 (older) and u2 (on the leaf's path)
    bed.emit(0, { type: "agent_settled", aborted: false });
    const { points, leafId } = await bed.service.branches(sessionId, OWNER);
    expect(leafId).toBe("a2");
    expect(points).toHaveLength(1);
    expect(points[0]?.parentId).toBe("a0");
    expect(points[0]?.choices.map((choice) => [choice.entryId, choice.onPath])).toEqual([
      ["u1", false],
      ["u2", true],
    ]);
  });

  it("has no point for a linear session, and none before the file exists", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.branches(sessionId, OWNER)).toEqual({
      leafId: null,
      points: [],
      truncated: false,
    });
    bed.writePiFile(0);
    bed.emit(0, { type: "agent_settled", aborted: false });
    expect(await bed.service.branches(sessionId, OWNER)).toEqual({
      leafId: "a0",
      points: [],
      truncated: false,
    });
  });
});

describe("the reads and their owner", () => {
  closeBedAfterEach();
  it("are not_found for another user's session and for a session that does not exist", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    writeToolSession(bed.files[0] ?? "", "c1", "out");
    bed.emit(0, { type: "agent_settled", aborted: false });
    for (const [caller, id] of [
      [OTHER, sessionId],
      [OWNER, "ghost"],
    ] as const) {
      expect(await codeOf(bed.service.history({ sessionId: id, before: "u0" }, caller))).toBe("not_found");
      expect(await codeOf(bed.service.toolOutput({ sessionId: id, toolCallId: "c1" }, caller))).toBe(
        "not_found",
      );
      expect(await codeOf(bed.service.branches(id, caller))).toBe("not_found");
    }
  });
});

describe("clipJsonText", () => {
  it("returns a text that fits as it is", () => {
    expect(clipJsonText("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("measures JSON bytes, not characters: quotes and control characters count for two to six", () => {
    const quotes = clipJsonText('"'.repeat(1000), 1000);
    expect(quotes.truncated).toBe(true);
    expect(quotes.text).toBe('"'.repeat(499));
    expect(Buffer.byteLength(JSON.stringify(quotes.text))).toBe(1000);
    const controls = clipJsonText("\u0001".repeat(1000), 1000);
    expect(Buffer.byteLength(JSON.stringify(controls.text))).toBeLessThanOrEqual(1000);
    expect(controls.text).toHaveLength(166);
  });

  it("never ends on half of a surrogate pair, whatever the budget", () => {
    for (const text of ["😀".repeat(100), "a😀".repeat(100)]) {
      for (let max = 3; max < 120; max++) {
        const clipped = clipJsonText(text, max).text;
        expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(max);
      }
    }
  });

  it("stringifies prefixes of at most `max` characters of a huge text (M2-RT-29)", () => {
    const huge = "y".repeat(5_000_000);
    const lengths: number[] = [];
    const real = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string") lengths.push(args[0].length);
      return real.apply(JSON, args as never);
    });
    try {
      const clipped = clipJsonText(huge, 1000);
      expect(clipped.text).toBe("y".repeat(998));
      expect(clipped.truncated).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1000);
    expect(lengths.length).toBeLessThanOrEqual(12);
  });
});

describe("fitPage", () => {
  const rowOf = (id: string, size: number) => ({
    entryId: id,
    message: { role: "user", content: "x".repeat(size) },
  });
  const page = (rows: TranscriptRow[]) => ({
    rows,
    hasMore: false,
    oldestEntryId: rows[0]?.entryId ?? null,
    turnsBefore: 0,
    leafId: "l",
  });

  it("returns a page that fits as it is", () => {
    const fits = page([rowOf("e1", 10), rowOf("e2", 10)]);
    expect(fitPage(fits, 10_000)).toBe(fits);
  });

  it("leaves the oldest rows out first, says there is more, moves the cursor and counts the turns left out", () => {
    const rows = [rowOf("e1", 400), rowOf("e2", 400), rowOf("e3", 400)];
    const fitted = fitPage({ ...page(rows), turnsBefore: 3 }, 1000);
    expect(fitted.rows.map((row) => row.entryId)).toEqual(["e2", "e3"]);
    expect(fitted).toMatchObject({ hasMore: true, oldestEntryId: "e2", turnsBefore: 4 });
  });

  it("replaces a row over the row cap by a placeholder instead of dropping the whole page", () => {
    const fitted = fitPage(page([rowOf("e1", 300_000)]), 900_000);
    expect(fitted.rows).toHaveLength(1);
    expect(fitted.rows[0]?.message).toMatchObject({ omitted: true, role: "user" });
    // Nothing was left out: the cursor and the counts are the page's own.
    expect(fitted).toMatchObject({ hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  });
});
