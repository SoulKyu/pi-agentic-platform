import { describe, expect, it } from "vitest";
import { FILE_LIMITS, FileEntry, FileMeta, FilePath, filesMethods, methods } from "./index.ts";

describe("FilePath", () => {
  it("accepts an absolute path and refuses a relative one, an empty one and a NUL", () => {
    expect(FilePath.safeParse("/a/b").success).toBe(true);
    for (const bad of ["a/b", "", "/a\u0000", `/${"a".repeat(FILE_LIMITS.pathBytes)}`]) {
      expect(FilePath.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("files methods", () => {
  it("are read-only queries with the files:read permission, spread into the catalogue", () => {
    for (const name of ["files.list", "files.read", "files.search"] as const) {
      expect(methods[name]).toBe(filesMethods[name]);
      expect(methods[name]).toMatchObject({ permission: "files:read", idempotent: true });
    }
    expect(filesMethods["files.list"].errors).toEqual(["not_found"]);
    expect(filesMethods["files.read"].errors).toEqual(["not_found"]);
    expect(filesMethods["files.search"].errors).toEqual(["not_found", "capacity"]);
  });

  it("files.read refuses an offset below 0 and above 2^53 - 1", () => {
    const { params } = filesMethods["files.read"];
    expect(params.safeParse({ path: "/a", offset: 0 }).success).toBe(true);
    expect(params.safeParse({ path: "/a", offset: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const offset of [-1, 2 ** 53, 1.5]) {
      expect(params.safeParse({ path: "/a", offset }).success, String(offset)).toBe(false);
    }
  });

  it("files.search refuses a 129-character query, an empty one and a limit of 51", () => {
    const { params } = filesMethods["files.search"];
    const ok = { root: "/r", query: "q".repeat(128), limit: 50 };
    expect(params.safeParse(ok).success).toBe(true);
    expect(params.safeParse({ ...ok, query: "q".repeat(129) }).success).toBe(false);
    expect(params.safeParse({ ...ok, query: "" }).success).toBe(false);
    expect(params.safeParse({ ...ok, limit: 51 }).success).toBe(false);
    expect(params.safeParse({ ...ok, limit: 0 }).success).toBe(false);
  });

  it("files.list answers at most 5 000 entries", () => {
    const entry = {
      name: "a",
      kind: "file",
      size: 1,
      mtimeMs: 1,
      hidden: null,
      protected: false,
      link: null,
      linkDir: false,
    };
    expect(FileEntry.safeParse(entry).success).toBe(true);
    const { result } = filesMethods["files.list"];
    expect(result.safeParse({ entries: Array(5000).fill(entry), truncated: false }).success).toBe(true);
    expect(result.safeParse({ entries: Array(5001).fill(entry), truncated: true }).success).toBe(false);
  });

  it("FileMeta carries the protection a save needs", () => {
    const meta = {
      path: "/a",
      size: 1,
      mtimeMs: 1,
      etag: "a".repeat(32),
      binary: false,
      editable: true,
      protection: "step_up",
    };
    expect(FileMeta.safeParse(meta).success).toBe(true);
    expect(FileMeta.safeParse({ ...meta, etag: "A".repeat(32) }).success).toBe(false);
    expect(FileMeta.safeParse({ ...meta, protection: "maybe" }).success).toBe(false);
  });
});
