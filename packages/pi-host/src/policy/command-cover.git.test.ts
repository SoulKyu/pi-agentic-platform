import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { coverCommand } from "./command-cover.ts";
import { makeBed } from "./cover-bed.ts";

const bed = makeBed();
afterAll(() => rmSync(bed.base, { recursive: true, force: true }));

const refusals = (why: string, commands: readonly string[], over: Parameters<typeof bed.ctx>[0] = {}) =>
  describe(why, () => {
    it.each(commands)("does not cover %s", async (command) => {
      expect(await coverCommand(command, bed.ctx(over))).toEqual({ covered: false, why });
    });
  });

refusals("git option", [
  "git -c core.pager=sh log",
  "git --exec-path=/tmp log",
  "git -p log",
  "git --paginate log",
  "git --git-dir=x log",
  "git --work-tree=x log",
  "git --config-env=a=B log",
]);
refusals("refused option", [
  "git log --output=/tmp/x",
  "git log --out=x",
  "git diff --ext-diff",
  "git diff --textconv",
  "git show --output=x",
  "git stash list --output=x",
  "git grep -O vim foo",
  "git grep --open-files-in-pager foo",
  "git cat-file --filters HEAD:x",
]);
refusals("git listing only", [
  "git branch new-feature",
  "git branch -D x",
  "git branch -m a b",
  "git remote add o u",
  "git remote show origin",
  "git branch --unset-upstream",
  "git branch --delete",
  "git remote -f",
  "git stash",
  "git stash pop",
  "git worktree add x",
]);
refusals("not a read-only git command", ["git tag v1", "git config --list", "git push", "git reflog"]);
refusals("searches pap's data directory", ["git status"], { cwd: bed.base });
refusals("searches pap's data directory", ["git -C src -C ../../agent grep --no-index token"]);
refusals("protected path", ["git -C src diff --no-index ../../agent/auth.json /dev/null"]);
refusals("git environment", ["git status"], { shell: { gitEnv: true } });
refusals("wrapper, assignment or keyword", [
  "GIT_DIR=x git status",
  "GIT_WORK_TREE=x git status",
  "GIT_COMMON_DIR=x git status",
  "GIT_OBJECT_DIRECTORY=x git status",
  "GIT_INDEX_FILE=x git status",
]);
refusals("git config runs a program", [
  "cd vendor/dirty && git status",
  "git -C lnk/.. status",
  "git -C vendor/dirty status",
  "git -C vendor -C dirty log -1",
  "cd vendor/dirty && git diff",
  "cd vendor/dirty && git show HEAD",
  "cd vendor/dirty && git blame x",
  "cd vendor/dirty && git grep foo",
  "cd vendor/dirty && git ls-files",
  "git status && git -C vendor/dirty log",
]);

describe("covered git", () => {
  it.each(["git branch --list 'feat*'", "git -C src log -1", "git status"])("covers %s", async (command) => {
    expect(await coverCommand(command, bed.ctx())).toEqual({ covered: true });
  });
});

// MC18: a folder that does not exist yet, or is still empty, is judged by the repository that encloses it. The engine
// cannot see a bare layout that a parallel write is about to create there; `safe.bareRepository=explicit` (git-env.ts) is
// what keeps git from reading it.
describe("a target folder inside a repository", () => {
  it.each(["git -C hm status", "cd hm && git status", "git -C src -C nope status"])(
    "is judged by the enclosing repository's clean config: %s",
    async (command) => {
      mkdirSync(join(bed.cwd, "src"), { recursive: true });
      expect(await coverCommand(command, bed.ctx())).toEqual({ covered: true });
    },
  );

  it("is not covered when the enclosing repository's config runs a program", async () => {
    const dirty = join(bed.cwd, "vendor", "dirty");
    expect(await coverCommand(`git -C ${dirty}/missing status`, bed.ctx())).toEqual({
      covered: false,
      why: "git config runs a program",
    });
  });
});
