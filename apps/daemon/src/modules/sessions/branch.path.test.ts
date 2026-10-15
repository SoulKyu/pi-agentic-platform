import { describe, expect, it } from "vitest";
import { BRANCH_PATH_MAX, branchPath, type EntryLike, indexEntries } from "./branch.ts";

const message = (id: string, parentId: string | null, role: string, text: string): EntryLike => ({
  type: "message",
  id,
  parentId,
  message: { role, content: text },
});
const convert = (entry: EntryLike): unknown[] => (entry.message ? [entry.message] : []);

describe("branchPath", () => {
  it("returns the current branch only, root first, with the previews of user messages", () => {
    const entries = indexEntries([
      message("1", null, "user", "first   ask"),
      message("2", "1", "assistant", "answer"),
      message("3", "2", "user", "abandoned"),
      message("4", "2", "user", "kept"),
      message("5", "4", "assistant", "done"),
    ]);
    expect(branchPath(entries, convert, "5")).toEqual({
      leafId: "5",
      entries: [
        { id: "1", parentId: null, user: true, preview: "first ask" },
        { id: "2", parentId: "1", user: false, preview: "" },
        { id: "4", parentId: "2", user: true, preview: "kept" },
        { id: "5", parentId: "4", user: false, preview: "" },
      ],
    });
  });

  it("follows the file's last entry when the leaf is unknown", () => {
    const entries = indexEntries([message("1", null, "user", "a"), message("2", "1", "assistant", "b")]);
    expect(branchPath(entries, convert, null).leafId).toBe("2");
    expect(branchPath(indexEntries([]), convert, null)).toEqual({ leafId: null, entries: [] });
  });

  it("keeps the newest 10 000 entries and drops the oldest", () => {
    const list = Array.from({ length: BRANCH_PATH_MAX + 1 }, (_, i) =>
      message(`e${i}`, i === 0 ? null : `e${i - 1}`, "assistant", "x"),
    );
    const path = branchPath(indexEntries(list), convert, null);
    expect(BRANCH_PATH_MAX).toBe(10_000);
    expect(path.entries).toHaveLength(10_000);
    expect(path.entries[0]?.id).toBe("e1");
    expect(path.entries.at(-1)?.id).toBe(`e${BRANCH_PATH_MAX}`);
    const exact = branchPath(indexEntries(list.slice(0, BRANCH_PATH_MAX)), convert, null);
    expect(exact.entries).toHaveLength(10_000);
    expect(exact.entries[0]?.id).toBe("e0");
  });
});
