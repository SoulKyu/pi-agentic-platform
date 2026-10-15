import { existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRealBed, type RealBed } from "./testing/real.ts";

let bed: RealBed;
beforeEach(() => {
  bed = createRealBed();
});
afterEach(() => bed.dispose());

const LANE = "fix-bug-1a2b";
const list = () => bed.repo.git(bed.repo.root, "worktree", "list", "--porcelain");
const branches = () => bed.repo.git(bed.repo.root, "branch", "--format=%(refname:short)");

async function readyLane() {
  const module = bed.module();
  const path = bed.reserve(module, LANE);
  await module.create(path);
  await module.ready(path);
  return { module, path };
}

describe("create then ready, with real git", () => {
  it("checks the branch out in a folder whose .git is a file, locked while creating and unlocked once ready", async () => {
    const module = bed.module();
    const path = bed.reserve(module, LANE);
    await module.create(path);
    expect(list()).toContain("locked pap-creating");
    await module.ready(path);
    expect(list()).toContain(`worktree ${path}`);
    expect(list()).not.toContain("locked");
    expect(lstatSync(join(path, ".git")).isFile()).toBe(true);
    expect(bed.repo.git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`pap/${LANE}`);
    expect(bed.repo.git(path, "rev-parse", "HEAD").trim()).toBe(bed.base);
    expect(module.byPath(path)?.state).toBe("ready");
  });
});

describe("remove, with real git", () => {
  it("removes a clean worktree: folder, registration and row gone, the branch kept", async () => {
    const { module, path } = await readyLane();
    expect(await module.remove({ path, force: false })).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(list()).not.toContain(path);
    expect(module.byPath(path)).toBeUndefined();
    expect(branches()).toContain(`pap/${LANE}`);
  });

  it("answers dirty on an untracked file and an edited file, and keeps the worktree", async () => {
    const { module, path } = await readyLane();
    writeFileSync(join(path, "new.txt"), "x");
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
    expect(existsSync(path)).toBe(true);
    expect(module.byPath(path)?.state).toBe("ready");
    writeFileSync(join(path, "a.txt"), "edited\n");
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
  });

  it("removes a dirty worktree with force", async () => {
    const { module, path } = await readyLane();
    writeFileSync(join(path, "new.txt"), "x");
    expect(await module.remove({ path, force: true })).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(list()).not.toContain(path);
  });

  it("deleteBranch on an unmerged branch answers false and keeps it, after a forced remove too (I3)", async () => {
    const { module, path } = await readyLane();
    writeFileSync(join(path, "work.txt"), "work\n");
    bed.repo.git(path, "add", "work.txt");
    bed.repo.git(path, "commit", "-q", "-m", "work");
    writeFileSync(join(path, "scratch.txt"), "dirty\n");
    expect(await module.remove({ path, force: true })).toEqual({ ok: true });
    const branch = `pap/${LANE}`;
    expect(await module.deleteBranch({ repoRoot: bed.repo.root, branch })).toBe(false);
    expect(branches()).toContain(branch);
  });
});

describe("the dirty check cannot be fooled (MC3)", () => {
  it("I1: reads a new file as dirty although the owner's config hides untracked files", async () => {
    bed.repo.git(bed.repo.root, "config", "status.showUntrackedFiles", "no");
    const { module, path } = await readyLane();
    writeFileSync(join(path, "agent-work.txt"), "uncommitted\n");
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
    expect(existsSync(join(path, "agent-work.txt"))).toBe(true);
  });

  it("I2: a core.worktree written into the lane's config.worktree redirects nothing", async () => {
    bed.repo.git(bed.repo.root, "config", "extensions.worktreeConfig", "true");
    const { module, path } = await readyLane();
    const admin = module.gitDirOf(path) as string;
    const elsewhere = join(bed.worktrees.dir, "empty-elsewhere");
    bed.repo.git(
      bed.repo.root,
      "config",
      "--file",
      join(admin, "config.worktree"),
      "core.worktree",
      elsewhere,
    );
    writeFileSync(join(path, "agent-work.txt"), "uncommitted\n");
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
    // Git does not fail either: without the file, the same check reads the lane itself and answers clean.
    rmSync(join(path, "agent-work.txt"));
    expect(await module.remove({ path, force: false })).toEqual({ ok: true });
  });

  it("I3: an admin dir already taken by the owner's other worktree makes git add a counter, and the stored dir follows", async () => {
    const outside = join(bed.worktrees.dir, "other-checkout", LANE);
    bed.repo.git(bed.repo.root, "worktree", "add", "-q", "-b", "owner-branch", outside);
    const { module, path } = await readyLane();
    const admin = module.gitDirOf(path) as string;
    expect(admin).toBe(join(bed.repo.root, ".git", "worktrees", `${LANE}1`));
    // The owner's worktree is clean; the lane has a new file: only the lane's own git dir can say dirty.
    writeFileSync(join(path, "agent-work.txt"), "uncommitted\n");
    expect(await module.remove({ path, force: false })).toEqual({ ok: false, reason: "dirty" });
    expect(await module.remove({ path, force: true })).toEqual({ ok: true });
    expect(existsSync(outside)).toBe(true);
    expect(list()).toContain(outside);
  });
});
