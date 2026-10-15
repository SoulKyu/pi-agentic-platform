import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneBed, type LaneBed } from "../testing/lane-bed.ts";
import type { GitRunner } from "./runner.ts";
import { snapshotTree } from "./snapshot.ts";

let lanes: LaneBed;
beforeEach(() => {
  lanes = createLaneBed();
});
afterEach(() => lanes.dispose());

const tree = (path: string, oid: string): string[] =>
  lanes.bed.git(path, "ls-tree", "-r", "--name-only", "-z", oid).split("\0").filter(Boolean);
const status = (path: string): string =>
  lanes.bed.git(path, "status", "--porcelain=v2", "--untracked-files=all");

describe("snapshotTree through a temporary index (M9R54)", () => {
  it("holds the modified, new and dash-named files, not the deleted one or an ignored .env", async () => {
    const { path, gitDir } = await lanes.lane("one");
    writeFileSync(join(path, ".gitignore"), ".env\n");
    lanes.bed.git(path, "add", ".gitignore");
    lanes.bed.git(path, "commit", "-q", "-m", "ignore");
    writeFileSync(join(path, "a.txt"), "changed\n");
    await rm(join(path, "-rf"));
    writeFileSync(join(path, "new.txt"), "new\n");
    writeFileSync(join(path, "--force"), "dash\n");
    writeFileSync(join(path, ".env"), "SECRET=1\n");
    const before = status(path);
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree).sort()).toEqual(["--force", ".gitignore", "a\nb", "a.txt", "new.txt"]);
    expect(lanes.bed.git(path, "show", `${snap.tree}:a.txt`)).toBe("changed\n");
    expect(snap.skipped).toBe(0);
    expect(status(path), "the real index is untouched").toBe(before);
    expect(readdirSync(lanes.indexDir)).toEqual([]);
  });

  it("snapshots an unborn branch", async () => {
    const { path, gitDir } = await lanes.lane("unborn");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/pi/unborn-branch\n");
    await rm(join(gitDir, "index"));
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree).sort()).toEqual(["-rf", "a\nb", "a.txt"]);
  });

  it("limits the tree to the given paths", async () => {
    const { path, gitDir } = await lanes.lane("paths");
    writeFileSync(join(path, "a.txt"), "changed\n");
    mkdirSync(join(path, "src"));
    writeFileSync(join(path, "src", "in.txt"), "in\n");
    writeFileSync(join(path, "other.txt"), "out\n");
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir, ["src", "a.txt"]);
    const names = tree(path, snap.tree);
    expect(names).toContain("src/in.txt");
    expect(names).not.toContain("other.txt");
    expect(lanes.bed.git(path, "show", `${snap.tree}:a.txt`)).toBe("changed\n");
    expect(lanes.bed.git(path, "show", `${snap.tree}:-rf`)).toBe("dash\n");
  });

  it("leaves an untracked file over the limit out, counts it, and never writes its blob", async () => {
    const { path, gitDir } = await lanes.lane("big");
    writeFileSync(join(path, "dev.db"), "x".repeat(1024 + 1));
    writeFileSync(join(path, "small.txt"), "x".repeat(1024));
    const blob = lanes.bed.git(path, "hash-object", "--no-filters", "dev.db").trim();
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir, undefined, 1024);
    expect(tree(path, snap.tree)).toContain("small.txt");
    expect(tree(path, snap.tree)).not.toContain("dev.db");
    expect(snap.skipped).toBe(1);
    expect(() => lanes.bed.git(path, "cat-file", "-e", blob)).toThrow();
  });

  it("keeps a file the lane ignores out, whatever copied it there (Task 4)", async () => {
    const { path, gitDir } = await lanes.lane("secret");
    mkdirSync(join(lanes.bed.root, ".git", "info"), { recursive: true });
    writeFileSync(join(lanes.bed.root, ".git", "info", "exclude"), "secrets/\n");
    mkdirSync(join(path, "secrets"));
    writeFileSync(join(path, "secrets", "token"), "t\n");
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree).some((name) => name.startsWith("secrets"))).toBe(false);
  });

  it("never follows a symlink: it stores the link", async () => {
    const { path, gitDir } = await lanes.lane("link");
    const outside = join(lanes.bed.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private"), "p\n");
    symlinkSync(outside, join(path, "out"));
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree)).toContain("out");
    expect(tree(path, snap.tree).some((name) => name.startsWith("out/"))).toBe(false);
    expect(lanes.bed.git(path, "cat-file", "-p", `${snap.tree}:out`)).toBe(outside);
  });

  it("removes the temporary index after a write-tree failure", async () => {
    const { path, gitDir } = await lanes.lane("fail");
    const failing: GitRunner = {
      run: async (root, args, options) => {
        if (args[0] === "write-tree") throw new Error("injected");
        return lanes.git.run(root, args, options);
      },
    };
    await expect(snapshotTree(failing, path, gitDir, lanes.indexDir)).rejects.toThrow("injected");
    expect(existsSync(lanes.indexDir) ? readdirSync(lanes.indexDir) : []).toEqual([]);
  });

  it("keeps a tracked file removed next to an intent-to-add copy of it: no rename pairing (T11-13)", async () => {
    const { path, gitDir } = await lanes.lane("rename");
    writeFileSync(join(path, "old.txt"), "same content\n");
    lanes.bed.git(path, "add", "old.txt");
    lanes.bed.git(path, "commit", "-q", "-m", "old");
    await rm(join(path, "old.txt"));
    writeFileSync(join(path, "new.txt"), "same content\n");
    lanes.bed.git(path, "add", "-N", "new.txt");
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree)).not.toContain("old.txt");
    expect(tree(path, snap.tree)).toContain("new.txt");
  });

  it("treats a FIFO at the index path as no index instead of hanging (T11-2)", async () => {
    const { path, gitDir } = await lanes.lane("fifo");
    await rm(join(gitDir, "index"));
    execFileSync("mkfifo", [join(gitDir, "index")]);
    writeFileSync(join(path, "new.txt"), "new\n");
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree).sort()).toEqual(["-rf", "a\nb", "a.txt", "new.txt"]);
  });

  it("rebuilds the index from HEAD when the copied one cannot be used", async () => {
    const { path, gitDir } = await lanes.lane("split");
    writeFileSync(join(gitDir, "index"), "not an index");
    writeFileSync(join(path, "new.txt"), "new\n");
    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, snap.tree).sort()).toEqual(["-rf", "a\nb", "a.txt", "new.txt"]);
  });
});

describe("gitlinks stay out of the staged list (MC2)", () => {
  it("never runs the clean filter of a nested repository, tracked gitlink or untracked", async () => {
    const { path, gitDir } = await lanes.lane("nested");
    const { script, marker } = lanes.bed.plant("nested-filter");
    const nested = (name: string): void => {
      const dir = join(path, name);
      mkdirSync(dir);
      lanes.bed.git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
      lanes.bed.git(dir, "config", "filter.evil.clean", script);
      writeFileSync(join(dir, "f.txt"), "one\n");
      lanes.bed.git(dir, "add", ".");
      lanes.bed.git(dir, "commit", "-q", "-m", "n");
    };
    nested("sub");
    const subHead = lanes.bed.git(join(path, "sub"), "rev-parse", "HEAD").trim();
    lanes.bed.git(path, "update-index", "--add", "--cacheinfo", `160000,${subHead},sub`);
    lanes.bed.git(path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "gitlink");
    await rm(marker, { force: true });
    writeFileSync(join(path, "sub", "f.txt"), "two\n");
    nested("loose");
    // The control: plain git in the nested repository runs the planted driver.
    lanes.bed.git(join(path, "sub"), "add", "f.txt");
    expect(existsSync(marker), "control").toBe(true);
    // The nested repository moved on: the lane's gitlink differs, and a modified file waits inside it.
    lanes.bed.git(join(path, "sub"), "commit", "-q", "--allow-empty", "-m", "moved");
    writeFileSync(join(path, "sub", "f.txt"), "three\n");
    await rm(marker, { force: true });
    writeFileSync(join(path, "top.txt"), "top\n");

    const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(existsSync(marker), "the nested driver did not run").toBe(false);
    expect(lanes.bed.git(path, "ls-tree", snap.tree, "sub").trim()).toBe(`160000 commit ${subHead}\tsub`);
    const names = tree(path, snap.tree);
    expect(names).toContain("top.txt");
    expect(names.some((name) => name.startsWith("loose"))).toBe(false);
  });
});

describe("a nested repository below an untracked folder (MC2, fix round 1)", () => {
  /** `vendor/readme.txt` beside `vendor/lib`, a repository with a clean filter and a modified file. */
  function vendor(path: string): { marker: string } {
    const { script, marker } = lanes.bed.plant("vendor-filter");
    const lib = join(path, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    lanes.bed.git(lib, "init", "-q", "-b", "main");
    writeFileSync(join(lib, ".gitattributes"), "*.txt filter=evil\n");
    lanes.bed.git(lib, "config", "filter.evil.clean", script);
    writeFileSync(join(lib, "f.txt"), "one\n");
    lanes.bed.git(lib, "add", ".gitattributes");
    lanes.bed.git(lib, "commit", "-q", "-m", "n");
    writeFileSync(join(lib, "f.txt"), "two\n");
    writeFileSync(join(path, "vendor", "readme.txt"), "r\n");
    return { marker };
  }
  const commits = (path: string, oid: string): string =>
    lanes.bed
      .git(path, "ls-tree", "-r", oid)
      .split("\n")
      .filter((line) => line.includes(" commit "))
      .join("\n");

  it("holds no 160000 entry in the capture and runs no nested filter, whole tree or scoped to the folder", async () => {
    const { path, gitDir } = await lanes.lane("vendor");
    const { marker } = vendor(path);
    for (const scope of [undefined, ["vendor"], ["vendor/lib"]]) {
      const snap = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir, scope);
      expect(commits(path, snap.tree), String(scope)).toBe("");
      expect(existsSync(marker), String(scope)).toBe(false);
    }
    const whole = await snapshotTree(lanes.git, path, gitDir, lanes.indexDir);
    expect(tree(path, whole.tree)).toContain("vendor/readme.txt");
  });
});
