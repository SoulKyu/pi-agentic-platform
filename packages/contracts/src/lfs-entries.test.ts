import { describe, expect, it } from "vitest";
import { LFS_ENTRIES } from "./index.ts";

describe("LFS_ENTRIES", () => {
  it("is the three standard git-lfs filter entries and nothing else", () => {
    expect([...LFS_ENTRIES]).toEqual([
      ["clean", "git-lfs clean -- %f"],
      ["smudge", "git-lfs smudge -- %f"],
      ["process", "git-lfs filter-process"],
    ]);
  });
});
