import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect, type WalkFs } from "./collect.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-collect-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (relative: string, text = "x"): void => {
  mkdirSync(join(root, relative, ".."), { recursive: true });
  writeFileSync(join(root, relative), text);
};

describe("collect", () => {
  it("walks folders and files, folders first as met, and counts the bytes", () => {
    file("agents/one/a.txt", "abc");
    file("agents/one/sub dir/b.txt", "de");
    file("agents/two.txt", "f");
    const result = collect(root, "agents");
    expect(result.entries).toEqual([
      "agents",
      "agents/one",
      "agents/one/a.txt",
      "agents/one/sub dir",
      "agents/one/sub dir/b.txt",
      "agents/two.txt",
    ]);
    expect(result.bytes).toBe(6);
    expect([result.skippedLinks, result.skippedNames, result.changed]).toEqual([0, 0, 0]);
  });

  it("returns nothing, silently, for a missing top", () => {
    expect(collect(root, "agents")).toEqual({
      entries: [],
      bytes: 0,
      skippedLinks: 0,
      skippedNames: 0,
      changed: 0,
      examples: [],
    });
  });

  it("skips and counts a symbolic link, and a name with a newline", () => {
    file("agents/real.txt");
    symlinkSync("/etc/passwd", join(root, "agents", "link"));
    file("agents/bad\nname.txt");
    const result = collect(root, "agents");
    expect(result.entries).toEqual(["agents", "agents/real.txt"]);
    expect(result.skippedLinks).toBe(1);
    expect(result.skippedNames).toBe(1);
    expect(result.examples).toEqual(["agents/bad?name.txt", "agents/link"]);
  });

  it("replaces control characters before it clips: a long skipped name keeps no ESC or BEL in the example", () => {
    file(`agents/\u001b[2J\u0007${"a".repeat(100)}.txt`);
    file("agents/ok.txt");
    const result = collect(root, "agents");
    expect(result.skippedNames).toBe(1);
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0]).not.toMatch(/\p{Cc}/u);
    expect(result.examples[0]?.endsWith("...")).toBe(true);
    expect(result.examples[0]?.length).toBe(80);
  });

  it("never follows a directory link: /etc is not listed", () => {
    mkdirSync(join(root, "agents"));
    symlinkSync("/etc", join(root, "agents", "etc"));
    const result = collect(root, "agents");
    expect(result.entries).toEqual(["agents"]);
    expect(result.skippedLinks).toBe(1);
  });

  it("refuses a top that is itself a link", () => {
    symlinkSync("/etc", join(root, "agents"));
    const result = collect(root, "agents");
    expect(result.entries).toEqual([]);
    expect(result.skippedLinks).toBe(1);
  });

  it("throws too many files past the limit", () => {
    file("agents/a");
    file("agents/b");
    expect(() => collect(root, "agents", 2)).toThrow("too many files");
  });

  it("counts a name that is not UTF-8 and still collects the later siblings (M6b-RT-04)", () => {
    mkdirSync(join(root, "agents"));
    // 0xFF sorts before "b": the first draft dropped everything after it
    writeFileSync(Buffer.concat([Buffer.from(join(root, "agents") + "/"), Buffer.from([0xff, 0x61])]), "x");
    file("agents/b.txt");
    file("agents/c.txt");
    const result = collect(root, "agents");
    expect(result.skippedNames).toBe(1);
    expect(result.entries).toEqual(["agents", "agents/b.txt", "agents/c.txt"]);
  });

  describe("with an injected file system", () => {
    const dir = { isDirectory: () => true, isFile: () => false, size: 0 };
    const regular = (size: number) => ({ isDirectory: () => false, isFile: () => true, size });
    const code = (value: string) => Object.assign(new Error(value), { code: value });

    it("counts a file that vanishes between readdir and lstat, with its path, and goes on", () => {
      const fs: WalkFs = {
        readdir: () => ["a", "gone", "z"],
        lstat: (path) => {
          if (path.endsWith("gone")) throw code("ENOENT");
          return path.endsWith("agents") ? dir : regular(2);
        },
      };
      const result = collect("/r", "agents", 100, fs);
      expect(result.entries).toEqual(["agents", "agents/a", "agents/z"]);
      expect(result.changed).toBe(1);
      expect(result.examples).toEqual(["agents/gone"]);
      expect(result.bytes).toBe(4);
    });

    it("counts a folder that vanishes between the lstat and readdir", () => {
      const fs: WalkFs = {
        readdir: (path) => {
          if (path.endsWith("sub")) throw code("ENOENT");
          return path.endsWith("agents") ? ["sub", "z"] : [];
        },
        lstat: (path) => (path.endsWith("z") ? regular(1) : dir),
      };
      const result = collect("/r", "agents", 100, fs);
      expect(result.changed).toBe(1);
      expect(result.entries).toEqual(["agents", "agents/sub", "agents/z"]);
    });

    it("throws on EACCES from lstat", () => {
      const fs: WalkFs = {
        readdir: () => ["a"],
        lstat: (path) => {
          if (path.endsWith("/a")) throw code("EACCES");
          return dir;
        },
      };
      expect(() => collect("/r", "agents", 100, fs)).toThrow("EACCES");
    });

    it("throws on EACCES from readdir", () => {
      const fs: WalkFs = {
        readdir: () => {
          throw code("EACCES");
        },
        lstat: () => dir,
      };
      expect(() => collect("/r", "agents", 100, fs)).toThrow("EACCES");
    });

    it("throws naming a file above 8 GiB - 1, and accepts one at the limit", () => {
      const limit = 8 * 1024 ** 3 - 1;
      const make = (size: number): WalkFs => ({
        readdir: () => ["big.bin"],
        lstat: (path) => (path.endsWith("big.bin") ? regular(size) : dir),
      });
      expect(collect("/r", "agents", 100, make(limit)).bytes).toBe(limit);
      expect(() => collect("/r", "agents", 100, make(limit + 1))).toThrow("agents/big.bin");
    });
  });

  it("skips and counts a path deeper than the restore reader accepts (128 parts), keeping the rest", () => {
    const ok = `agents/${"d/".repeat(126)}f`; // 128 parts
    const deep = `agents/${"d/".repeat(127)}f`; // 129 parts
    file(ok);
    file(deep);
    file("agents/other.txt");
    const result = collect(root, "agents");
    expect(result.entries).toContain(ok);
    expect(result.entries).not.toContain(deep);
    expect(result.entries).toContain("agents/other.txt");
    expect(result.skippedNames).toBe(1);
    expect(result.examples[0]).toMatch(/^agents\/d\/d\/.*\.\.\.$/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "skips and counts a folder without owner read or execute, with what is below it",
    () => {
      file("agents/locked/inner.txt");
      file("agents/readonly/inner.txt");
      file("agents/open/inner.txt");
      chmodSync(join(root, "agents/locked"), 0o600);
      chmodSync(join(root, "agents/readonly"), 0o555);
      try {
        const result = collect(root, "agents");
        expect(result.entries).toEqual([
          "agents",
          "agents/open",
          "agents/open/inner.txt",
          "agents/readonly",
          "agents/readonly/inner.txt",
        ]);
        expect(result.skippedNames).toBe(1);
        expect(result.examples).toEqual(["agents/locked"]);
      } finally {
        chmodSync(join(root, "agents/locked"), 0o700);
        chmodSync(join(root, "agents/readonly"), 0o700);
      }
    },
  );
});
