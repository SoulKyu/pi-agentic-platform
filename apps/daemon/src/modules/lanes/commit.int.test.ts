import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFilters } from "../../kernel/git/filters.ts";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createCommitter } from "./git-ops.ts";
import { createLaneLocks } from "./lane-lock.ts";
import type { LaneRow } from "./store.ts";

let bed: GitBed;
let plant: { script: string; marker: string };
beforeEach(() => {
  bed = createGitBed();
  writeFileSync(join(bed.home, ".gitconfig"), "[user]\n\tname = Owner\n\temail = owner@example.com\n");
  plant = addGitlink();
  notices.length = 0;
});
afterEach(() => bed.dispose());

/** The main repository gets `sub`, a gitlink whose nested repository carries a clean filter that writes a marker. */
function addGitlink(): { script: string; marker: string } {
  const plant = bed.plant("nested-clean");
  const sub = join(bed.root, "sub");
  mkdirSync(sub);
  bed.git(sub, "init", "-q", "-b", "main");
  writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(sub, "f"), "one\n");
  bed.git(sub, "add", ".");
  bed.git(sub, "commit", "-q", "-m", "s");
  bed.git(bed.root, "add", "sub");
  bed.git(bed.root, "commit", "-q", "-m", "gitlink");
  return plant;
}

/** A lane whose `sub` is a live nested repository with a changed file and its clean filter configured. */
function laneWithGitlink(name: string, newCommit = false): { path: string; gitDir: string } {
  const path = join(bed.dir, name);
  bed.git(bed.root, "worktree", "add", "-q", "-b", `pi/${name}`, path);
  rmdirSync(join(path, "sub"));
  cpSync(join(bed.root, "sub"), join(path, "sub"), { recursive: true });
  // A new commit inside: the guarded status shows the gitlink as changed (SC..), which a commit must leave out.
  if (newCommit) bed.git(join(path, "sub"), "commit", "--allow-empty", "-q", "-m", "n");
  bed.git(join(path, "sub"), "config", "filter.x.clean", plant.script);
  bed.git(join(path, "sub"), "config", "filter.x.required", "false");
  writeFileSync(join(path, "sub", "f"), "two\n");
  return { path, gitDir: join(bed.root, ".git", "worktrees", name) };
}

const notices: unknown[][] = [];

function committerFor(path: string, dir: string, id: string) {
  const row = { id, ownerId: "u1", worktree: path, state: "active" } as LaneRow;
  const locks = createLaneLocks(() => id);
  return createCommitter({
    store: { getOwned: () => row },
    git: guardFilters(bed.runner()),
    gitDirOf: () => dir,
    lock: locks.laneLock,
    refresh: async () => undefined,
    publish: () => undefined,
    notices: { add: (...args) => void notices.push(args) },
    logger: silentLogger,
    readOnly: false,
  });
}
const commit = (path: string, dir: string, paths: string[], message = "Add z\n\nbody") =>
  committerFor(path, dir, "lane-1").commit(testCaller(), { laneId: "lane-1", paths, message });
const log = (path: string, format: string): string => bed.git(path, "log", "-1", `--format=${format}`);

describe("lanes.commit against real git", () => {
  it("commits the chosen files with the lane trailer, and runs no clean filter of a nested repository", async () => {
    const lane = laneWithGitlink("one");
    // Control: plain `git add -A` in an identical lane starts the nested clean filter.
    const control = laneWithGitlink("control");
    writeFileSync(join(control.path, "z.txt"), "z\n");
    bed.git(control.path, "add", "-A", "--", ".");
    expect(existsSync(plant.marker)).toBe(true);
    rmSync(plant.marker);

    writeFileSync(join(lane.path, "z.txt"), "z\n");
    writeFileSync(join(lane.path, "other.txt"), "o\n");
    const result = await commit(lane.path, lane.gitDir, ["sub", "z.txt"]);
    expect(result.ok).toBe(true);
    expect(existsSync(plant.marker)).toBe(false);
    expect(log(lane.path, "%an <%ae>%n%B")).toContain("Owner <owner@example.com>");
    expect(log(lane.path, "%B").trimEnd().endsWith("body\n\nPap-Lane: lane-1")).toBe(true);
    expect(bed.git(lane.path, "show", "--name-only", "--format=", "HEAD").trim()).toBe("z.txt");
    // The file that was not chosen stays untracked; the gitlink is untouched.
    expect(bed.git(lane.path, "status", "--porcelain", "--ignore-submodules=dirty").trim()).toBe(
      "?? other.txt",
    );
  });

  it("leaves a gitlink out of the commit when the guarded status lists it as changed", async () => {
    const lane = laneWithGitlink("six", true);
    writeFileSync(join(lane.path, "z.txt"), "z\n");
    expect(bed.git(lane.path, "status", "--porcelain=v2", "--ignore-submodules=dirty")).toContain(" SC.. ");
    const result = await commit(lane.path, lane.gitDir, ["sub", "z.txt"]);
    expect(result.ok).toBe(true);
    expect(existsSync(plant.marker)).toBe(false);
    expect(bed.git(lane.path, "show", "--name-only", "--format=", "HEAD").trim()).toBe("z.txt");
    expect(bed.git(lane.path, "status", "--porcelain=v2", "--ignore-submodules=dirty")).toContain(" SC.. ");
  });

  it("commits a deletion and a rename", async () => {
    const lane = laneWithGitlink("two");
    bed.git(lane.path, "mv", "a.txt", "renamed.txt");
    rmSync(join(lane.path, "-rf"));
    const result = await commit(lane.path, lane.gitDir, ["renamed.txt", "-rf"]);
    expect(result.ok).toBe(true);
    const shown = bed.git(lane.path, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
    expect(shown).toEqual(["D\t-rf", "R100\ta.txt\trenamed.txt"]);
  });

  it("answers nothing_to_commit for a clean file", async () => {
    const lane = laneWithGitlink("three");
    expect(await commit(lane.path, lane.gitDir, ["a.txt"])).toEqual({
      ok: false,
      reason: "nothing_to_commit",
    });
  });

  it("answers identity_missing when git has no identity to use", async () => {
    const lane = laneWithGitlink("four");
    writeFileSync(join(bed.home, ".gitconfig"), "[user]\n\tuseConfigOnly = true\n");
    writeFileSync(join(lane.path, "z.txt"), "z\n");
    expect(await commit(lane.path, lane.gitDir, ["z.txt"])).toEqual({
      ok: false,
      reason: "identity_missing",
    });
  });

  it("runs no hook of the repository", async () => {
    const lane = laneWithGitlink("five");
    const hook = bed.plant("pre-commit");
    const hooks = join(bed.root, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\n${hook.script}\n`);
    chmodSync(join(hooks, "pre-commit"), 0o755);
    writeFileSync(join(lane.path, "z.txt"), "z\n");
    expect((await commit(lane.path, lane.gitDir, ["z.txt"])).ok).toBe(true);
    expect(existsSync(hook.marker)).toBe(false);
  });

  describe("a nested repository the add would embed (MC2, fix round 1)", () => {
    /** `vendor/readme.txt` beside `vendor/lib`, a repository with a clean filter and a modified file. */
    function vendor(path: string): void {
      const lib = join(path, "vendor", "lib");
      mkdirSync(lib, { recursive: true });
      bed.git(lib, "init", "-q", "-b", "main");
      writeFileSync(join(lib, ".gitattributes"), "*.txt filter=evil\n");
      bed.git(lib, "config", "filter.evil.clean", plant.script);
      writeFileSync(join(lib, "f.txt"), "one\n");
      bed.git(lib, "add", ".gitattributes");
      bed.git(lib, "commit", "-q", "-m", "n");
      writeFileSync(join(lib, "f.txt"), "two\n");
      writeFileSync(join(path, "vendor", "readme.txt"), "r\n");
    }
    const gitlinks = (path: string): string =>
      bed
        .git(path, "ls-tree", "-r", "HEAD")
        .split("\n")
        .filter((line) => line.startsWith("160000"))
        .join("\n");

    it("choosing the folder commits its files and no 160000 entry, runs no nested filter, and says so", async () => {
      const lane = laneWithGitlink("vendor-dir");
      vendor(lane.path);
      rmSync(plant.marker, { force: true });
      const before = gitlinks(lane.path);
      const result = await commit(lane.path, lane.gitDir, ["vendor/"]);
      expect(result.ok).toBe(true);
      expect(bed.git(lane.path, "show", "--name-only", "--format=", "HEAD").trim()).toBe("vendor/readme.txt");
      expect(gitlinks(lane.path)).toBe(before);
      expect(existsSync(plant.marker)).toBe(false);
      expect(bed.git(lane.path, "ls-files", "--stage", "vendor")).not.toContain("160000");
      expect(notices).toEqual([["lane-1", "nested_repo_left_out", 1]]);
    });

    it("choosing the nested repository itself commits nothing, and says so", async () => {
      const lane = laneWithGitlink("vendor-lib");
      vendor(lane.path);
      rmSync(plant.marker, { force: true });
      const head = bed.git(lane.path, "rev-parse", "HEAD");
      expect(await commit(lane.path, lane.gitDir, ["vendor/lib"])).toEqual({
        ok: false,
        reason: "nothing_to_commit",
      });
      expect(bed.git(lane.path, "rev-parse", "HEAD")).toBe(head);
      expect(bed.git(lane.path, "ls-files", "--stage", "vendor")).toBe("");
      expect(existsSync(plant.marker)).toBe(false);
      expect(notices).toEqual([["lane-1", "nested_repo_left_out", 1]]);
    });

    it("a file chosen next to a nested repository is committed alone", async () => {
      const lane = laneWithGitlink("vendor-file");
      vendor(lane.path);
      expect((await commit(lane.path, lane.gitDir, ["vendor/readme.txt"])).ok).toBe(true);
      expect(bed.git(lane.path, "show", "--name-only", "--format=", "HEAD").trim()).toBe("vendor/readme.txt");
      expect(notices).toEqual([]);
    });
  });
});
