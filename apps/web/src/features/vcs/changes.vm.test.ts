import { VCS_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { changesEn } from "../../i18n/catalog/changes.ts";
import { vcsFile } from "../../testing/m8-fixtures.ts";
import {
  absolutePath,
  countsOf,
  displayPath,
  groupFiles,
  inRoot,
  KIND_KEYS,
  kindTone,
  rowPath,
} from "./changes.vm.ts";

describe("groupFiles", () => {
  it("puts conflicts first, then changes, then untracked, each ordered by path", () => {
    const groups = groupFiles([
      vcsFile("z.ts"),
      vcsFile("new.txt", { kind: "untracked" }),
      vcsFile("a.ts", { kind: "added" }),
      vcsFile("m.ts", { kind: "conflicted" }),
      vcsFile("b.txt", { kind: "untracked" }),
      vcsFile("c.ts", { kind: "conflicted" }),
    ]);
    expect(groups.map((group) => [group.id, group.files.map((file) => file.path)])).toEqual([
      ["conflicts", ["c.ts", "m.ts"]],
      ["changes", ["a.ts", "z.ts"]],
      ["untracked", ["b.txt", "new.txt"]],
    ]);
  });

  it("leaves out a group without files", () => {
    expect(groupFiles([vcsFile("a.ts")]).map((group) => group.id)).toEqual(["changes"]);
    expect(groupFiles([])).toEqual([]);
  });
});

describe("labels", () => {
  it("names every kind with a word of the catalog, and a tone", () => {
    expect(Object.keys(KIND_KEYS)).toHaveLength(8);
    expect(Object.keys(KIND_KEYS).map((kind) => kindTone(kind as keyof typeof KIND_KEYS))).toEqual([
      "run",
      "ok",
      "err",
      "mut",
      "mut",
      "mut",
      "ext",
      "err",
    ]);
    for (const key of Object.values(KIND_KEYS)) expect(changesEn).toHaveProperty(key);
    expect(changesEn[KIND_KEYS.typechange]).toBe("Type changed");
    expect(changesEn[KIND_KEYS.conflicted]).toBe("Conflict");
  });

  it("formats counts as +12 −3 and says nothing for a binary file or unknown counts", () => {
    expect(countsOf(vcsFile("a", { additions: 12, deletions: 3 }))).toBe("+12 −3");
    expect(countsOf(vcsFile("a", { additions: 0, deletions: 0 }))).toBe("+0 −0");
    expect(countsOf(vcsFile("a", { additions: null, deletions: null }))).toBeNull();
    expect(countsOf(vcsFile("a", { additions: 5, deletions: 1, binary: true }))).toBeNull();
  });

  it("shows a rename as old to new, with invisible and bidi characters dropped", () => {
    expect(rowPath(vcsFile("new.ts", { kind: "renamed", oldPath: "old.ts" }))).toBe("old.ts → new.ts");
    expect(rowPath(vcsFile("a.ts"))).toBe("a.ts");
    expect(displayPath("a‮b​.ts")).toBe("ab.ts");
  });

  it("clips a very long path", () => {
    const shown = displayPath("a/".repeat(2000));
    expect(Array.from(shown)).toHaveLength(513);
    expect(shown.endsWith("…")).toBe(true);
  });
});

describe("paths", () => {
  it("joins the root and the repository path", () => {
    expect(absolutePath("/p", "src/a.ts")).toBe("/p/src/a.ts");
    expect(absolutePath("/", "a.ts")).toBe("/a.ts");
  });

  it("tells a folder inside the root from a sibling that shares its prefix", () => {
    expect(inRoot("/p", "/p")).toBe(true);
    expect(inRoot("/p", "/p/sub")).toBe(true);
    expect(inRoot("/p", "/pp")).toBe(false);
    expect(inRoot("/p", "/q")).toBe(false);
  });

  it("keeps the truncation text in step with the server's cap", () => {
    expect(VCS_LIMITS.files).toBe(2000);
    expect(changesEn["changes.state.truncated"]).toBe("Showing the first 2 000 changes");
  });
});
