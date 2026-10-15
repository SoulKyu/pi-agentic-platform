import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { createRealBed, type RealBed } from "./testing/real.ts";

// A crash between the two phases is simulated by doing phase 2 by hand with plain git, then booting a fresh module.
let bed: RealBed;
beforeEach(() => {
  bed = createRealBed();
});
afterEach(() => bed.dispose());

const LANE = "fix-bug-1a2b";
const branch = `pap/${LANE}`;
const list = () => bed.repo.git(bed.repo.root, "worktree", "list", "--porcelain");
const branches = () => bed.repo.git(bed.repo.root, "branch", "--format=%(refname:short)");
const state = (path: string) =>
  bed.worktrees.db.get<{ state: string }>("SELECT state FROM worktrees WHERE path = $path", { path })?.state;
const makeBranch = () => bed.repo.git(bed.repo.root, "branch", "--no-track", branch, bed.base);
const addLocked = (path: string) =>
  bed.repo.git(bed.repo.root, "worktree", "add", "--lock", "--reason=pap-creating", path, branch);

describe("recovery of a creating row (M9R20)", () => {
  it("deletes a branch made at the base when no worktree was added, and the row", async () => {
    const path = bed.reserve(bed.module(), LANE);
    makeBranch();
    await bed.module().recover();
    expect(branches()).not.toContain(branch);
    expect(state(path)).toBeUndefined();
    expect(bed.worktrees.logged("worktree_recovered")).toEqual([
      expect.objectContaining({ step: "creating" }),
    ]);
    expect(JSON.stringify(bed.worktrees.lines)).not.toContain(path);
  });

  it("removes the folder, the locked registration and the branch after a crash following worktree add --lock", async () => {
    const path = bed.reserve(bed.module(), LANE);
    makeBranch();
    addLocked(path);
    expect(list()).toContain("locked");
    await bed.module().recover();
    expect(existsSync(path)).toBe(false);
    expect(list()).not.toContain(path);
    expect(branches()).not.toContain(branch);
    expect(state(path)).toBeUndefined();
  });

  it("unlocks first, so a locked registration whose folder was deleted goes too (M9-RT-03)", async () => {
    const path = bed.reserve(bed.module(), LANE);
    makeBranch();
    addLocked(path);
    bed.repo.git(bed.repo.root, "worktree", "list");
    const { rmSync } = await import("node:fs");
    rmSync(path, { recursive: true, force: true });
    await bed.module().recover();
    expect(list()).not.toContain(path);
    expect(bed.repo.git(bed.repo.root, "worktree", "list")).not.toContain(LANE);
    expect(branches()).not.toContain(branch);
    expect(state(path)).toBeUndefined();
  });

  it("keeps a branch that got a commit meanwhile, logs worktree_branch_kept, and the commit stays reachable", async () => {
    const path = bed.reserve(bed.module(), LANE);
    makeBranch();
    addLocked(path);
    writeFileSync(join(path, "work.txt"), "work\n");
    bed.repo.git(path, "add", "work.txt");
    bed.repo.git(path, "commit", "-q", "-m", "work");
    const tip = bed.repo.git(path, "rev-parse", "HEAD").trim();
    await bed.module().recover();
    expect(existsSync(path)).toBe(false);
    expect(branches()).toContain(branch);
    expect(bed.repo.git(bed.repo.root, "rev-parse", branch).trim()).toBe(tip);
    expect(bed.worktrees.logged("worktree_branch_kept")).toHaveLength(1);
    expect(state(path)).toBeUndefined();
  });

  it("refuses a symlink planted at the path: the target is untouched, the refusal is logged", async () => {
    const path = bed.reserve(bed.module(), LANE);
    const target = join(bed.worktrees.dir, "target");
    mkdirSync(join(bed.worktrees.papHome, "worktrees"), { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "precious.txt"), "keep");
    symlinkSync(target, path);
    await bed.module().recover();
    expect(existsSync(join(target, "precious.txt"))).toBe(true);
    expect(bed.worktrees.logged("worktree_folder_refused")).toHaveLength(1);
  });
});

describe("recovery of a removing row", () => {
  it("finishes the removal", async () => {
    const module = bed.module();
    const path = bed.reserve(module, LANE);
    await module.create(path);
    await module.ready(path);
    bed.worktrees.db.run("UPDATE worktrees SET state = 'removing' WHERE path = $path", { path });
    await bed.module().recover();
    expect(existsSync(path)).toBe(false);
    expect(list()).not.toContain(path);
    expect(state(path)).toBeUndefined();
    expect(branches()).toContain(branch);
    expect(bed.worktrees.logged("worktree_recovered")).toEqual([
      expect.objectContaining({ step: "removing" }),
    ]);
  });
});

describe("recovery on a read-only database", () => {
  it("calls no git and logs worktree_recovery_skipped", async () => {
    const path = bed.reserve(bed.module(), LANE);
    const calls: string[][] = [];
    const git: GitRunner = {
      async run(_root, args) {
        calls.push([...args]);
        throw new GitError("failed");
      },
    };
    await bed.module({ readOnly: true, git }).recover();
    expect(calls).toEqual([]);
    expect(bed.worktrees.logged("worktree_recovery_skipped")).toHaveLength(1);
    expect(state(path)).toBe("creating");
  });
});

describe("a ready worktree is left alone", () => {
  it("does not touch ready rows", async () => {
    const module = bed.module();
    const path = bed.reserve(module, LANE);
    await module.create(path);
    await module.ready(path);
    await bed.module().recover();
    expect(existsSync(path)).toBe(true);
    expect(state(path)).toBe("ready");
  });
});
