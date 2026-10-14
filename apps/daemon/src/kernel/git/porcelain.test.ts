import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "./porcelain.ts";

const OID = "a".repeat(40);
const H = "b".repeat(40);
const rec = (...records: string[]) => Buffer.from(records.map((r) => `${r}\0`).join(""), "utf8");

describe("parsePorcelainV2 branch headers", () => {
  it("reads oid, head, upstream and ahead/behind", () => {
    const out = parsePorcelainV2(
      rec(`# branch.oid ${OID}`, "# branch.head main", "# branch.upstream origin/main", "# branch.ab +3 -1"),
    );
    expect(out.branch).toEqual({
      oid: OID,
      head: "main",
      detached: false,
      upstream: "origin/main",
      ahead: 3,
      behind: 1,
    });
    expect(out.entries).toEqual([]);
  });

  it("reads an initial repository with no commit", () => {
    const out = parsePorcelainV2(rec("# branch.oid (initial)", "# branch.head main"));
    expect(out.branch).toEqual({
      oid: null,
      head: "main",
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
    });
  });

  it("reads a detached head", () => {
    const out = parsePorcelainV2(rec(`# branch.oid ${OID}`, "# branch.head (detached)"));
    expect(out.branch).toMatchObject({ oid: OID, head: null, detached: true, upstream: null });
  });

  it("has no upstream and no counts when the headers are absent", () => {
    const out = parsePorcelainV2(rec(`# branch.oid ${OID}`, "# branch.head topic"));
    expect(out.branch).toMatchObject({ upstream: null, ahead: null, behind: null });
  });
});

const ord = (xy: string, path: string, sub = "N...") =>
  `1 ${xy} ${sub} 100644 100644 100644 ${OID} ${H} ${path}`;

describe("parsePorcelainV2 entries", () => {
  it("reads ordinary changes", () => {
    const out = parsePorcelainV2(
      rec(ord(".M", "m.txt"), ord("A.", "a.txt"), ord("D.", "d.txt"), ord(".T", "t.txt")),
    );
    expect(out.entries).toEqual([
      { kind: "ordinary", index: ".", worktree: "M", path: "m.txt", origPath: null, submodule: "N..." },
      { kind: "ordinary", index: "A", worktree: ".", path: "a.txt", origPath: null, submodule: "N..." },
      { kind: "ordinary", index: "D", worktree: ".", path: "d.txt", origPath: null, submodule: "N..." },
      { kind: "ordinary", index: ".", worktree: "T", path: "t.txt", origPath: null, submodule: "N..." },
    ]);
  });

  it("reads a rename with its original path", () => {
    const out = parsePorcelainV2(
      rec(`2 R. N... 100644 100644 100644 ${OID} ${H} R100 new name.txt`, "old.txt"),
    );
    expect(out.entries).toEqual([
      {
        kind: "renamed",
        index: "R",
        worktree: ".",
        path: "new name.txt",
        origPath: "old.txt",
        submodule: "N...",
      },
    ]);
  });

  it("reads a copy", () => {
    const out = parsePorcelainV2(rec(`2 C. N... 100644 100644 100644 ${OID} ${H} C75 copy.txt`, "src.txt"));
    expect(out.entries).toEqual([
      { kind: "copied", index: "C", worktree: ".", path: "copy.txt", origPath: "src.txt", submodule: "N..." },
    ]);
  });

  it("reads an unmerged path", () => {
    const out = parsePorcelainV2(
      rec(`u UU N... 100644 100644 100644 100644 ${OID} ${H} ${OID} conflict.txt`),
    );
    expect(out.entries).toEqual([
      {
        kind: "unmerged",
        index: "U",
        worktree: "U",
        path: "conflict.txt",
        origPath: null,
        submodule: "N...",
      },
    ]);
  });

  it("reads untracked paths and skips ignored ones", () => {
    const out = parsePorcelainV2(rec("? new.txt", "! build/out.js", "? dir/"));
    expect(out.entries.map((e) => [e.kind, e.path])).toEqual([
      ["untracked", "new.txt"],
      ["untracked", "dir/"],
    ]);
  });

  it("keeps the submodule flag", () => {
    const out = parsePorcelainV2(rec(ord(".M", "vendor/lib", "S.M.")));
    expect(out.entries[0]).toMatchObject({ path: "vendor/lib", submodule: "S.M." });
  });

  it("returns a space, a newline and a leading dash exactly", () => {
    const out = parsePorcelainV2(rec(ord(".M", "a b.txt"), ord(".M", "a\nb"), ord(".M", "-rf"), "? -x y"));
    expect(out.entries.map((e) => e.path)).toEqual(["a b.txt", "a\nb", "-rf", "-x y"]);
  });

  it("skips an unknown record type and parses the rest", () => {
    const out = parsePorcelainV2(rec("# branch.head main", "Z future record", ord(".M", "ok.txt")));
    expect(out.entries.map((e) => e.path)).toEqual(["ok.txt"]);
    expect(out.branch.head).toBe("main");
  });

  it("skips a malformed record and parses the rest", () => {
    const out = parsePorcelainV2(rec("1 .M too short", ord(".M", "ok.txt")));
    expect(out.entries.map((e) => e.path)).toEqual(["ok.txt"]);
  });

  it("does not take the next record as the original path when a rename lacks one", () => {
    const out = parsePorcelainV2(rec(`2 R. N... 100644 100644 100644 ${OID} ${H} R100 new.txt`));
    expect(out.entries).toEqual([]);
  });
});
