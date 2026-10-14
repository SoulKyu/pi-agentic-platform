import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checker, repo, tempRoot } from "./git-config-guard.fixtures.ts";
import { GIT_SUBMODULES, GIT_UNREADABLE } from "./git-config-guard.ts";
import { MAX_INDEX_BYTES } from "./git-index.ts";

/** M7 ruling MC9: an embedded repository recorded as a gitlink in the index is recursed into by `git status`. */

let root: string;
let home: string;
beforeEach(() => {
  ({ root, home } = tempRoot());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const check = (start: string) => checker(home)(start);

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}
function realRepo(name: string): string {
  const top = join(root, name);
  mkdirSync(top);
  git(top, "init", "-q");
  writeFileSync(join(top, "a.txt"), "a");
  git(top, "add", "a.txt");
  return top;
}

describe("the index of the discovered repository", () => {
  it("is clean for a real repository without gitlinks", async () => {
    expect(await check(realRepo("r"))).toBeNull();
  });

  it("asks for an embedded repository added with git add, with no .gitmodules", async () => {
    const top = realRepo("r");
    const sub = join(top, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q");
    git(sub, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    git(top, "add", "sub");
    expect(await check(top)).toBe(GIT_SUBMODULES);
  });

  it("asks for a gitlink added with update-index --cacheinfo", async () => {
    const top = realRepo("r");
    git(
      top,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,0123456789abcdef0123456789abcdef01234567,vendor",
    );
    expect(await check(join(top, "src-missing"))).toBe(GIT_SUBMODULES);
  });

  it("asks for a garbage index, an index that is a folder, and an oversized index", async () => {
    const a = repo(join(root, "a"));
    writeFileSync(join(a, ".git", "index"), "garbage");
    expect(await check(a)).toBe(GIT_UNREADABLE);
    const b = repo(join(root, "b"));
    mkdirSync(join(b, ".git", "index"));
    expect(await check(b)).toBe(GIT_UNREADABLE);
    const c = repo(join(root, "c"));
    writeFileSync(join(c, ".git", "index"), "");
    truncateSync(join(c, ".git", "index"), MAX_INDEX_BYTES + 1);
    expect(await check(c)).toBe(GIT_UNREADABLE);
  });

  it("asks for a shared index file (split index)", async () => {
    const top = repo(join(root, "r"));
    writeFileSync(join(top, ".git", "sharedindex.0123456789abcdef0123456789abcdef01234567"), "");
    expect(await check(top)).toBe(GIT_UNREADABLE);
  });
});
