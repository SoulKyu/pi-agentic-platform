import { describe, expect, it } from "vitest";
import {
  type EntryLike,
  findToolCall,
  forkPoints,
  type IndexedEntries,
  indexEntries,
  MIN_RAW_WINDOW,
  readBranchPage,
} from "./branch.ts";

const msg = (
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
): EntryLike => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-10-11T00:00:${id.length}`,
  message: { role, content: text, timestamp: 1, ...extra },
});
// What the SDK's sessionEntryToContextMessages does for the entry types used here.
const convert = (entry: EntryLike): unknown[] =>
  entry.type === "message"
    ? [entry.message]
    : entry.type === "compaction"
      ? [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore }]
      : [];

const linear = (pairs: number) => {
  const list: EntryLike[] = [msg("sys", null, "system", "prompt")];
  let parent = "sys";
  for (let i = 0; i < pairs; i++) {
    list.push(msg(`u${i}`, parent, "user", `q${i}`), msg(`a${i}`, `u${i}`, "assistant", `r${i}`));
    parent = `a${i}`;
  }
  return indexEntries(list);
};
const ids = (rows: Array<{ entryId: string | null }>) => rows.map((row) => row.entryId);

describe("branch rows", () => {
  it("shows the active branch without the system prompt, newest last, with entry ids", () => {
    const page = readBranchPage(linear(2), convert, { limit: 75 });
    expect(ids(page.rows)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(page).toMatchObject({ hasMore: false, turnsBefore: 0, leafId: "a1" });
  });

  it("pages older rows from just above a cursor and counts the turns above", () => {
    const entries = linear(10);
    const newest = readBranchPage(entries, convert, { limit: 4 });
    expect(ids(newest.rows)).toEqual(["u8", "a8", "u9", "a9"]);
    expect(newest).toMatchObject({ hasMore: true, oldestEntryId: "u8", turnsBefore: 8 });
    const older = readBranchPage(entries, convert, { before: "u8", limit: 4 });
    expect(ids(older.rows)).toEqual(["u6", "a6", "u7", "a7"]);
    expect(older.turnsBefore).toBe(6);
  });

  it("follows the leaf it is given, not the file's last entry", () => {
    const entries = indexEntries([
      ...linear(1).list,
      msg("u1", "a0", "user", "edited"),
      msg("a1", "u1", "assistant", "two"),
      msg("u2", "a0", "user", "other branch"),
    ]);
    expect(ids(readBranchPage(entries, convert, { leafId: "a1", limit: 75 }).rows)).toEqual([
      "u0",
      "a0",
      "u1",
      "a1",
    ]);
    expect(ids(readBranchPage(entries, convert, { limit: 75 }).rows)).toEqual(["u0", "a0", "u2"]);
  });

  it("shows a compaction as a summary row and keeps the history before it", () => {
    const list = [
      ...linear(2).list,
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: "t",
        summary: "earlier work",
        tokensBefore: 900,
      } as EntryLike,
    ];
    const page = readBranchPage(indexEntries(list), convert, { limit: 75 });
    expect(ids(page.rows)).toEqual(["u0", "a0", "u1", "a1", "c1"]);
    expect(page.rows.at(-1)?.message).toEqual({
      role: "compactionSummary",
      summary: "earlier work",
      tokensBefore: 900,
    });
  });

  it("lists fork points with each choice's newest leaf", () => {
    const list = [
      ...linear(1).list,
      msg("u1", "a0", "user", "first try"),
      msg("a1", "u1", "assistant", "x"),
      msg("u2", "a0", "user", "second try"),
      msg("a2", "u2", "assistant", "y"),
    ];
    expect(forkPoints(indexEntries(list), convert, "a2")).toEqual([
      {
        parentId: "a0",
        choices: [
          { entryId: "u1", preview: "first try", target: "a1", timestamp: expect.any(String), onPath: false },
          { entryId: "u2", preview: "second try", target: "a2", timestamp: expect.any(String), onPath: true },
        ],
      },
    ]);
  });

  it("cuts a timestamp copied from the file to 64 characters", () => {
    const list = [
      msg("u0", null, "user", "one"),
      { ...msg("u1", "u0", "user", "a"), timestamp: "t".repeat(5000) },
      msg("u2", "u0", "user", "b"),
    ];
    const [point] = forkPoints(indexEntries(list), convert, "u2");
    expect(point?.choices[0]?.timestamp).toBe("t".repeat(64));
  });

  it("finds a tool call's arguments and its result", () => {
    const list = [
      msg("u0", null, "user", "go"),
      {
        type: "message",
        id: "a0",
        parentId: "u0",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } }],
        },
      } as EntryLike,
      msg("t0", "a0", "toolResult", "full output", { toolCallId: "c1" }),
    ];
    expect(findToolCall(indexEntries(list), "c1")).toEqual({
      args: { path: "big.txt" },
      result: expect.objectContaining({ role: "toolResult", content: "full output" }),
    });
    expect(findToolCall(indexEntries(list), "nope")).toEqual({ args: null, result: null });
  });

  it("takes the call of a given result entry, with the nearest call before it, when an id is reused", () => {
    const call = (id: string, parentId: string, path: string) =>
      ({
        type: "message",
        id,
        parentId,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c", name: "read", arguments: { path } }],
        },
      }) as EntryLike;
    const list = [
      msg("u0", null, "user", "go"),
      call("a0", "u0", "one"),
      msg("t0", "a0", "toolResult", "first", { toolCallId: "c" }),
      call("a1", "t0", "two"),
      msg("t1", "a1", "toolResult", "second", { toolCallId: "c" }),
    ];
    const indexed = indexEntries(list);
    expect(findToolCall(indexed, "c", "t1", "t0")).toEqual({
      args: { path: "one" },
      result: expect.objectContaining({ content: "first" }),
    });
    expect(findToolCall(indexed, "c", "t1", "t1")).toMatchObject({ args: { path: "two" } });
    expect(findToolCall(indexed, "c", "t0", "t1")).toEqual({ args: null, result: null });
    expect(findToolCall(indexed, "x", "t1", "t0")).toEqual({ args: null, result: null });
    expect(findToolCall(indexed, "c", "t1", "a0")).toEqual({ args: null, result: null });
  });
});

describe("bounded walks (M2-RT-03)", () => {
  it("returns a finite page and fork points for a self-cycle and a 2-cycle", () => {
    const selfCycle = indexEntries([msg("u0", "u0", "user", "loop")]);
    expect(ids(readBranchPage(selfCycle, convert, { limit: 75 }).rows)).toEqual(["u0"]);
    expect(forkPoints(selfCycle, convert)).toEqual([]);
    const twoCycle = indexEntries([
      msg("a", "b", "user", "one"),
      msg("b", "a", "assistant", "two"),
      msg("c", "a", "user", "three"),
    ]);
    expect(ids(readBranchPage(twoCycle, convert, { leafId: "b", limit: 75 }).rows)).toEqual(["a", "b"]);
    expect(ids(readBranchPage(twoCycle, convert, { before: "a", limit: 75 }).rows)).toEqual(["a", "b"]);
    expect(forkPoints(twoCycle, convert, "b").map((point) => point.parentId)).toEqual(["a"]);
  });

  it("counts a cycle's turns above the page once each, not once per lap", () => {
    const cycle = indexEntries([
      msg("a", "c", "user", "1"),
      msg("b", "a", "user", "2"),
      msg("c", "b", "user", "3"),
    ]);
    expect(readBranchPage(cycle, convert, { leafId: "c", limit: 1 })).toMatchObject({
      hasMore: true,
      turnsBefore: 2,
      oldestEntryId: "c",
    });
  });

  it("stops after one step per entry of the list even when the links lead further", () => {
    // A hand-built index whose parent links (byId) lead through 1000 entries while the list holds one: the step cap
    // is what ends the walk; no entry repeats, so the visited set cannot.
    const chain = Array.from({ length: 1000 }, (_, i) =>
      msg(`n${i}`, i === 0 ? null : `n${i - 1}`, "user", "x"),
    );
    const real = indexEntries(chain);
    const capped: IndexedEntries = { ...real, list: [chain[999] as EntryLike] };
    expect(readBranchPage(capped, convert, { limit: 5000 }).rows).toHaveLength(1);
    expect(forkPoints(capped, convert, "n999")).toEqual([]);
  });

  it("walks no more than the raw window for a page of rows that show nothing", () => {
    const hidden = Array.from({ length: 1000 }, (_, i) => ({
      type: "custom",
      id: `h${i}`,
      parentId: i === 0 ? null : `h${i - 1}`,
      timestamp: "t",
    }));
    const entries = indexEntries([...hidden, msg("u", "h999", "user", "visible")]);
    const page = readBranchPage(entries, convert, { limit: 2 });
    expect(ids(page.rows)).toEqual(["u"]);
    expect(page.oldestEntryId).toBe("h801");
    expect(MIN_RAW_WINDOW).toBe(200);
  });

  it("computes the newest descendant once for a cycle and a deep chain", () => {
    const deep = Array.from({ length: 5000 }, (_, i) =>
      msg(`d${i}`, i === 0 ? null : `d${i - 1}`, "user", "x"),
    );
    const index = indexEntries([...deep, msg("x", "x", "user", "self")]);
    expect(index.newest.get("d0")?.id).toBe("d4999");
    expect(index.newest.get("x")?.id).toBe("x");
    const looped = indexEntries([msg("a", "b", "user", "1"), msg("b", "a", "user", "2")]);
    expect(looped.newest.get("a")?.id).toBe("b");
  });
});
