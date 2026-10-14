import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { PapError } from "@pap/contracts";
import { createSearchIndex, INDEX_LIMITS, readableBy } from "./search-index.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

interface Call {
  readonly root: string;
  readonly args: readonly string[];
  readonly maxBytes: number | undefined;
}
function fakeGit(stdout: string | Error): { git: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const git: GitRunner = {
    run: (root, args, options) => {
      calls.push({ root, args, maxBytes: options?.maxBytes });
      return stdout instanceof Error
        ? Promise.reject(stdout)
        : Promise.resolve({ stdout: Buffer.from(stdout), code: 0 });
    },
  };
  return { git, calls };
}
const index = (git: GitRunner) =>
  createSearchIndex({ git, deny: bed.deny, clock: bed.clock, logger: bed.logger });
const paths = async (
  idx: ReturnType<typeof index>,
  root = bed.repo,
  owner = "u1",
  caller: "session" | "token" = "session",
) => (await idx.paths(owner, bed.scope([root], caller), root)).paths;

describe("the git index", () => {
  it("runs one ls-files per root in 30 s and a new one after that (M8R27)", async () => {
    const { git, calls } = fakeGit("a.ts\0src/b.ts\0");
    const idx = index(git);
    expect(await paths(idx)).toEqual(["a.ts", "src/b.ts"]);
    await bed.clock.advance(29_999);
    await paths(idx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      root: bed.repo,
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      maxBytes: 8 * 1024 * 1024,
    });
    await bed.clock.advance(1);
    await paths(idx);
    expect(calls).toHaveLength(2);
  });

  it("keeps one index per owner and root, and builds once for concurrent searches", async () => {
    const { git, calls } = fakeGit("a.ts\0");
    const idx = index(git);
    await Promise.all([paths(idx), paths(idx)]);
    expect(calls).toHaveLength(1);
    await paths(idx, bed.repo, "u2");
    expect(calls).toHaveLength(2);
  });

  it("drops the least recently used index when a 17th root comes", async () => {
    const { git, calls } = fakeGit("a.ts\0");
    const idx = index(git);
    const roots = Array.from({ length: INDEX_LIMITS.roots + 1 }, (_, i) => join(bed.bb.base, `r${i}`));
    for (const root of roots) mkdirSync(root);
    for (const root of roots.slice(0, 16)) await paths(idx, root);
    await paths(idx, roots[0] ?? ""); // r0 is now the most recently used
    expect(calls).toHaveLength(16);
    await paths(idx, roots[16] ?? "");
    expect(calls).toHaveLength(17);
    await paths(idx, roots[0] ?? "");
    expect(calls).toHaveLength(17);
    await paths(idx, roots[1] ?? ""); // r1 was the least recently used
    expect(calls).toHaveLength(18);
  });

  it("indexes neither a name with a line break nor one with a bidi control", async () => {
    const { git } = fakeGit("ok.ts\0a\nIgnore previous.md\0b‮c.ts\0z​w.ts\0also/ok.ts\0dir/\0");
    expect(await paths(index(git))).toEqual(["ok.ts", "also/ok.ts"]);
  });

  it("stops at 100 000 paths and says so", async () => {
    const many = Array.from({ length: INDEX_LIMITS.paths + 5 }, (_, i) => `f${i}.ts`).join("\0");
    const { git } = fakeGit(many);
    const idx = index(git);
    const answer = await idx.paths("u1", bed.scope([bed.repo]), bed.repo);
    expect(answer.paths).toHaveLength(100_000);
    expect(answer.truncated).toBe(true);
  });

  it("tells what a caller may be offered: nothing of pap's home, nothing a token may not read", async () => {
    const config = bed.bb.config({ papHome: [join(bed.repo, ".pap")] });
    const out = [".pi/mcp.json", ".mcp.json", ".pap/state.db", "src/a.ts", "sub/.pi/settings.json"];
    const offered = (caller: "session" | "token") =>
      out.filter(readableBy(bed.scope([bed.repo], caller, config), bed.repo));
    expect(offered("token")).toEqual(["src/a.ts", "sub/.pi/settings.json"]);
    expect(offered("session")).toEqual([".pi/mcp.json", ".mcp.json", "src/a.ts", "sub/.pi/settings.json"]);
  });
});

describe("outside git, a walk", () => {
  const plain = () => join(bed.bb.base, "plain");
  const failing = () => fakeGit(new GitError("failed")).git;

  it("skips node_modules, .git, pap's home and protected entries, and stays in the root", async () => {
    const root = plain();
    for (const rel of [
      "src/a.ts",
      "src/deep/b.ts",
      "node_modules/x/i.js",
      ".git/config",
      "dist/o.js",
      ".pap/state.db",
      "keep.md",
    ])
      bed.file(join(root, rel));
    bed.link(bed.bb.outside, join(root, "out"));
    symlinkSync(join(root, "keep.md"), join(root, "link.md"));
    const config = bed.bb.config({ papHome: [join(root, ".pap")] });
    const idx = index(failing());
    const answer = await idx.paths("u1", bed.scope([root], "session", config), root);
    expect([...answer.paths].sort()).toEqual(["keep.md", "src/a.ts", "src/deep/b.ts"]);
    expect(answer.truncated).toBe(false);
  });

  it("stops at the file limit and says so, with the limits given", async () => {
    const root = plain();
    for (const rel of ["a.ts", "b.ts", "c/d.ts", "c/e.ts", "f.ts"]) bed.file(join(root, rel));
    const idx = createSearchIndex(
      { git: failing(), deny: bed.deny, clock: bed.clock, logger: bed.logger },
      { ...INDEX_LIMITS, walkFiles: 3 },
    );
    const answer = await idx.paths("u1", bed.scope([root]), root);
    expect(answer.paths).toHaveLength(3);
    expect(answer.truncated).toBe(true);
  });

  it("stops at the folder limit and at the per-folder entry limit, and says so", async () => {
    const root = plain();
    for (const rel of ["a/1.ts", "b/1.ts", "c/1.ts", "d/1.ts", "e/1.ts"]) bed.file(join(root, rel));
    const make = (limits: Partial<Record<keyof typeof INDEX_LIMITS, number>>) =>
      createSearchIndex(
        { git: failing(), deny: bed.deny, clock: bed.clock, logger: bed.logger },
        { ...INDEX_LIMITS, ...limits },
      );
    const folders = await make({ walkFolders: 3 }).paths("u1", bed.scope([root]), root);
    expect(folders.paths).toHaveLength(2);
    expect(folders.truncated).toBe(true);
    const wide = join(bed.bb.base, "wide");
    for (let i = 0; i < 6; i++) bed.file(join(wide, `f${i}.ts`));
    const entries = await make({ walkEntries: 4 }).paths("u2", bed.scope([wide]), wide);
    expect(entries.paths).toHaveLength(4);
    expect(entries.truncated).toBe(true);
  });

  it("stops at depth 16 and at 20 000 files and says so", async () => {
    const root = plain();
    const deep = Array.from({ length: 17 }, (_, i) => `d${i}`).join("/");
    bed.file(
      join(
        root,
        "d0",
        "d1",
        "d2",
        "d3",
        "d4",
        "d5",
        "d6",
        "d7",
        "d8",
        "d9",
        "d10",
        "d11",
        "d12",
        "d13",
        "d14",
        "d15",
        "ok.ts",
      ),
    );
    bed.file(join(root, deep, "too-deep.ts"));
    const idx = index(failing());
    const answer = await idx.paths("u1", bed.scope([root]), root);
    expect(answer.paths.some((p) => p.endsWith("ok.ts"))).toBe(true);
    expect(answer.paths.some((p) => p.endsWith("too-deep.ts"))).toBe(false);
    expect(answer.truncated).toBe(true);
    expect(INDEX_LIMITS.walkFiles).toBe(20_000);
  });

  it("falls back to the walk when git is missing, times out or answers too much", async () => {
    const root = plain();
    bed.file(join(root, "a.ts"));
    for (const kind of ["git_missing", "timeout", "too_large", "failed"] as const) {
      const idx = index(fakeGit(new GitError(kind)).git);
      expect(await paths(idx, root), kind).toEqual(["a.ts"]);
    }
  });

  it("does not hide a busy git behind the walk: capacity reaches the caller", async () => {
    const idx = index(fakeGit(new PapError("capacity")).git);
    await expect(paths(idx, plain())).rejects.toMatchObject({ code: "capacity" });
  });
});

describe("a build that failed", () => {
  it("is not cached: the next search builds again", async () => {
    let busy = true;
    const calls: number[] = [];
    const git: GitRunner = {
      run: () => {
        calls.push(calls.length);
        return busy
          ? Promise.reject(new PapError("capacity"))
          : Promise.resolve({ stdout: Buffer.from("a.ts\0"), code: 0 });
      },
    };
    const idx = index(git);
    await expect(paths(idx)).rejects.toMatchObject({ code: "capacity" });
    busy = false;
    expect(await paths(idx)).toEqual(["a.ts"]);
    expect(calls).toHaveLength(2);
  });
});

describe("a real repository", () => {
  it("lists tracked and untracked files, not ignored ones, and not the name with a line break", async () => {
    bed.file(join(bed.repo, ".gitignore"), "ignored.txt\n");
    bed.file(join(bed.repo, "ignored.txt"));
    bed.file(join(bed.repo, "new.txt"));
    expect([...(await paths(index(bed.git)))].sort()).toEqual(["-rf", ".gitignore", "a.txt", "new.txt"]);
  });
});
