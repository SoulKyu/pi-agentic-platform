import { FILE_LIMITS, type FileEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPANDED,
  MAX_TABS,
  VIEW_LIMIT_BYTES,
  displayName,
  openTab,
  rawUrl,
  rowAccess,
  tabTitles,
  touchExpanded,
  viewKind,
  visibleRows,
  type Folder,
} from "./files.vm.ts";

const entry = (name: string, patch: Partial<FileEntry> = {}): FileEntry => ({
  name,
  kind: "file",
  size: 1,
  mtimeMs: 1,
  hidden: null,
  protected: false,
  link: null,
  linkDir: false,
  ...patch,
});
const dir = (name: string, patch: Partial<FileEntry> = {}) => entry(name, { kind: "dir", ...patch });
const folder = (...entries: FileEntry[]): Folder => ({ status: "ready", entries, truncated: false });

describe("visibleRows", () => {
  it("lists the root's children, then the children of each expanded folder under it, in order", () => {
    const folders = new Map<string, Folder>([
      ["/p", folder(dir("a"), dir("b"), entry("z.txt"))],
      ["/p/a", folder(dir("deep"), entry("a1.ts"))],
      ["/p/a/deep", folder(entry("d.md"))],
      ["/p/b", folder(entry("b1.ts"))],
    ]);
    const rows = visibleRows("/p", ["/p/a", "/p/b", "/p/a/deep"], folders);
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      "0:/p/a",
      "1:/p/a/deep",
      "2:/p/a/deep/d.md",
      "1:/p/a/a1.ts",
      "0:/p/b",
      "1:/p/b/b1.ts",
      "0:/p/z.txt",
    ]);
    expect(rows.filter((row) => row.expanded).map((row) => row.path)).toEqual(["/p/a", "/p/a/deep", "/p/b"]);
  });

  it("does not descend into a folder that is expanded but not loaded, or protected, or outside", () => {
    const folders = new Map<string, Folder>([
      [
        "/p",
        folder(
          dir("open"),
          dir(".pi", { protected: true }),
          entry("out", { kind: "link", link: "outside", linkDir: true }),
        ),
      ],
      ["/p/.pi", folder(entry("secret"))],
      ["/p/out", folder(entry("x"))],
    ]);
    const rows = visibleRows("/p", ["/p/open", "/p/.pi", "/p/out"], folders);
    expect(rows.map((row) => row.path)).toEqual(["/p/open", "/p/.pi", "/p/out"]);
  });
});

describe("rowAccess", () => {
  it("a protected or outside-linking entry is locked and neither expandable nor openable", () => {
    expect(rowAccess(dir("a", { protected: true }))).toEqual({
      expandable: false,
      openable: false,
      lock: "protected",
    });
    expect(rowAccess(entry("l", { kind: "link", link: "outside", linkDir: true }))).toEqual({
      expandable: false,
      openable: false,
      lock: "outside",
    });
    expect(rowAccess(entry("f", { kind: "link", link: "outside" }))).toEqual({
      expandable: false,
      openable: false,
      lock: "outside",
    });
  });

  it("folders and links to folders inside expand; files and links to files inside open; the rest is inert", () => {
    expect(rowAccess(dir("a"))).toEqual({ expandable: true, openable: false, lock: null });
    expect(rowAccess(entry("l", { kind: "link", link: "inside", linkDir: true }))).toEqual({
      expandable: true,
      openable: false,
      lock: null,
    });
    expect(rowAccess(entry("f"))).toEqual({ expandable: false, openable: true, lock: null });
    expect(rowAccess(entry("l", { kind: "link", link: "inside" }))).toEqual({
      expandable: false,
      openable: true,
      lock: null,
    });
    expect(rowAccess(entry("s", { kind: "other" }))).toEqual({
      expandable: false,
      openable: false,
      lock: null,
    });
    expect(rowAccess(entry("b", { kind: "link", link: "broken" }))).toEqual({
      expandable: false,
      openable: false,
      lock: null,
    });
  });
});

describe("touchExpanded", () => {
  it("keeps at most MAX_EXPANDED and forgets the least recently opened", () => {
    let expanded: readonly string[] = [];
    for (let index = 0; index < MAX_EXPANDED; index++) expanded = touchExpanded(expanded, `/p/d${index}`);
    expect(expanded).toHaveLength(20);
    const next = touchExpanded(expanded, "/p/d20");
    expect(next).toHaveLength(20);
    expect(next).not.toContain("/p/d0");
    expect(next.at(-1)).toBe("/p/d20");
    expect(next[0]).toBe("/p/d1");
  });

  it("never forgets an ancestor of the folder just opened", () => {
    let expanded: readonly string[] = ["/p/a"];
    for (let index = 0; index < MAX_EXPANDED - 1; index++) expanded = touchExpanded(expanded, `/p/x${index}`);
    const next = touchExpanded(expanded, "/p/a/child");
    expect(next).toContain("/p/a");
    expect(next).not.toContain("/p/x0");
    expect(next).toHaveLength(20);
  });
});

describe("displayName", () => {
  it("drops invisible characters and clips to 255 characters", () => {
    expect(displayName(`ev${String.fromCodePoint(0x202e)}il.txt`)).toBe("evil.txt");
    expect(displayName(`a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x0a)}c`)).toBe("abc");
    expect(displayName("n".repeat(400))).toHaveLength(FILE_LIMITS.nameBytes);
  });
});

describe("viewKind and rawUrl", () => {
  const meta = (binary: boolean) => ({ binary });
  it("sorts a file into binary, image, markdown or text", () => {
    expect(viewKind("/p/a.bin", meta(true))).toBe("binary");
    expect(viewKind("/p/PHOTO.PNG", meta(true))).toBe("image");
    expect(viewKind("/p/logo.svg", meta(false))).toBe("image");
    expect(viewKind("/p/README.md", meta(false))).toBe("markdown");
    expect(viewKind("/p/a.ts", meta(false))).toBe("text");
  });

  it("encodes the path and asks for a download when told to", () => {
    expect(rawUrl("/p/a b&c.png")).toBe(`/files/raw?path=${encodeURIComponent("/p/a b&c.png")}`);
    expect(rawUrl("/p/a.zip", true)).toBe(`/files/raw?path=${encodeURIComponent("/p/a.zip")}&download=1`);
  });
});

describe("openTab", () => {
  const eight = Array.from({ length: MAX_TABS }, (_, index) => `/p/f${index}`);
  it("a 9th file closes the oldest clean tab", () => {
    expect(openTab(eight, "/p/new", new Set())).toEqual([...eight.slice(1), "/p/new"]);
  });
  it("skips dirty tabs, and refuses when all eight are dirty", () => {
    expect(openTab(eight, "/p/new", new Set(["/p/f0"]))).toEqual(["/p/f0", ...eight.slice(2), "/p/new"]);
    expect(openTab(eight, "/p/new", new Set(eight))).toBeNull();
  });
  it("an open file stays where it is", () => {
    expect(openTab(eight, "/p/f3", new Set())).toBe(eight);
  });
});

describe("the viewer cap", () => {
  it("is a whole number of the server's read chunks", () => {
    expect(VIEW_LIMIT_BYTES % FILE_LIMITS.readChunkBytes).toBe(0);
    expect(VIEW_LIMIT_BYTES).toBeGreaterThan(FILE_LIMITS.editableBytes);
  });
});

describe("tabTitles", () => {
  it("is the base name when it is unique", () => {
    expect(tabTitles(["/p/a/x.ts", "/p/b/y.ts"])).toEqual(["x.ts", "y.ts"]);
  });

  it("adds the shortest parent path that tells same-named files apart", () => {
    expect(tabTitles(["/p/a/index.ts", "/p/b/index.ts", "/p/readme.md"])).toEqual([
      "index.ts (a)",
      "index.ts (b)",
      "readme.md",
    ]);
    expect(tabTitles(["/p/a/x/index.ts", "/p/b/x/index.ts"])).toEqual(["index.ts (a/x)", "index.ts (b/x)"]);
  });

  it("goes only as deep as the group needs, and strips invisible characters from the parents", () => {
    expect(tabTitles(["/p/a/x/i.ts", "/p/b/x/i.ts", "/p/c/i.ts"])).toEqual([
      "i.ts (a/x)",
      "i.ts (b/x)",
      "i.ts (c)",
    ]);
    expect(tabTitles(["/p/a\u202Eb/i.ts", "/p/c/i.ts"])).toEqual(["i.ts (ab)", "i.ts (c)"]);
  });
});
