import { lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFilters } from "../../kernel/git/filters.ts";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { applyCopyLink } from "./copy-link.ts";

let bed: GitBed;
beforeEach(() => {
  bed = createGitBed();
});
afterEach(() => bed.dispose());

/** The repository ignores with `rules`; a lane is added from it (the rules are tracked, so the lane has them too). */
function lane(rules: string): { worktree: string; gitDir: string } {
  writeFileSync(join(bed.root, ".gitignore"), rules);
  bed.git(bed.root, "add", ".gitignore");
  bed.git(bed.root, "commit", "-q", "-m", "ignore");
  mkdirSync(join(bed.root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(bed.root, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(bed.root, ".env"), "SECRET=1\n");
  const worktree = join(bed.dir, "lane");
  bed.git(bed.root, "worktree", "add", "-q", "-b", "lane", worktree);
  return { worktree, gitDir: join(bed.root, ".git", "worktrees", "lane") };
}

const apply = (target: { worktree: string; gitDir: string }, over: { copy?: string[]; link?: string[] }) => {
  const log: string[] = [];
  const done = applyCopyLink({
    root: bed.root,
    ...target,
    copy: over.copy ?? [],
    link: over.link ?? [],
    git: guardFilters(bed.runner()),
    boundary: { papHome: [], agentDir: [], home: [], papHomeOpen: [], runtimeDirs: [] },
    deny: { has: async () => false, warm: () => {} },
    denyFolders: [],
    log: (line) => log.push(line),
    diskFloor: async () => {},
  });
  return done.then((result) => ({ ...result, log }));
};

describe("copy and link with real git", () => {
  it("copies an ignored .env and links node_modules when the lane ignores it as itself", async () => {
    const target = lane(".env\n/node_modules\n");
    const result = await apply(target, { copy: [".env"], link: ["node_modules"] });
    expect(result).toEqual({ skipped: 0, log: [] });
    expect(readlinkSync(join(target.worktree, "node_modules"))).toBe(join(bed.root, "node_modules"));
    expect(bed.git(target.worktree, "status", "--porcelain")).toBe("");
  });

  it("undoes the link under the usual `node_modules/` rule, so the lane never looks dirty (M9-RT-05)", async () => {
    const target = lane(".env\nnode_modules/\n");
    const result = await apply(target, { link: ["node_modules"] });
    expect(result.skipped).toBe(1);
    expect(result.log[0]).toContain("add `/node_modules` (no trailing slash) to .gitignore to link it");
    expect(lstatSync(join(target.worktree, "node_modules"), { throwIfNoEntry: false })).toBeUndefined();
    expect(bed.git(target.worktree, "status", "--porcelain")).toBe("");
  });

  it("copies nothing that git does not ignore", async () => {
    const target = lane("node_modules/\n");
    const result = await apply(target, { copy: [".env"] });
    expect(result.skipped).toBe(1);
    expect(result.log[0]).toContain("not_ignored");
    expect(lstatSync(join(target.worktree, ".env"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("removes a copy the lane's own rules do not ignore, so it is never committed (review I2)", async () => {
    const target = lane("node_modules/\n");
    // The owner's working copy of .gitignore ignores .env (uncommitted); the base branch's committed rules do not.
    writeFileSync(join(bed.root, ".gitignore"), ".env\nnode_modules/\n");
    const result = await apply(target, { copy: [".env"] });
    expect(result.skipped).toBe(1);
    expect(result.log[0]).toContain("add `/.env` to .gitignore to copy it");
    expect(lstatSync(join(target.worktree, ".env"), { throwIfNoEntry: false })).toBeUndefined();
    expect(bed.git(target.worktree, "status", "--porcelain")).toBe("");
  });
});
