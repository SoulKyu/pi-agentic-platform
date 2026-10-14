import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLEAN, checker, DIRTY, gitDir, repo, tempRoot } from "./git-config-guard.fixtures.ts";
import { GIT_RUNS_PROGRAM, GIT_UNREADABLE } from "./git-config-guard.ts";

/**
 * M7 ruling MC7: the guard accepts only a strict subset of what git accepts as a repository, so any doubt asks. Each
 * row below was a case where real git (2.53) used a planted repository the first guard did not recognise, or the
 * reverse. Every variant is tried in both directions: a dirty outer repository with a fake inner `.git` (git walks on
 * to the outer one), and a clean outer repository with a dirty inner one (git may use the inner one).
 */

let root: string;
let home: string;
beforeEach(() => {
  ({ root, home } = tempRoot());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const check = (start: string) => checker(home)(start);

const asRoot = process.getuid?.() === 0;
const HEX = "0123456789abcdef0123456789abcdef01234567";

/** Break a hand-built git directory in one way. */
const VARIANTS: ReadonlyArray<readonly [string, (dir: string) => void, boolean?]> = [
  [
    "HEAD is a dangling symlink to refs/heads/nope",
    (dir) => {
      rmSync(join(dir, "HEAD"));
      symlinkSync("refs/heads/nope", join(dir, "HEAD"));
    },
  ],
  ["HEAD is 40 uppercase hex", (dir) => writeFileSync(join(dir, "HEAD"), `${HEX.toUpperCase()}\n`)],
  ["HEAD is 40 hex followed by junk", (dir) => writeFileSync(join(dir, "HEAD"), `${HEX}xyz\n`)],
  [
    "HEAD is a ref line followed by 5000 line breaks",
    (dir) => writeFileSync(join(dir, "HEAD"), `ref: refs/heads/main${"\n".repeat(5000)}`),
  ],
  [
    "objects is an executable regular file",
    (dir) => {
      rmSync(join(dir, "objects"), { recursive: true });
      writeFileSync(join(dir, "objects"), "", { mode: 0o755 });
    },
  ],
  [
    "HEAD separates ref: and the path with a form feed",
    (dir) => writeFileSync(join(dir, "HEAD"), "ref:\frefs/heads/main\n"),
  ],
  [
    "HEAD is a symlink to a file holding a ref line",
    (dir) => {
      writeFileSync(join(dir, "HEADX"), "ref: refs/heads/main\n");
      rmSync(join(dir, "HEAD"));
      symlinkSync("HEADX", join(dir, "HEAD"));
    },
  ],
  [
    "HEAD has 300 spaces between ref: and the path",
    (dir) => writeFileSync(join(dir, "HEAD"), `ref:${" ".repeat(300)}refs/heads/main\n`),
  ],
  [
    "HEAD names a 300-character ref (past git's 255-byte read)",
    (dir) => writeFileSync(join(dir, "HEAD"), `ref: refs/heads/${"a".repeat(300)}\n`),
  ],
  [
    "objects has mode 0600",
    (dir) => {
      chmodSync(join(dir, "objects"), 0o600);
    },
    true,
  ],
  [
    "refs has mode 0600",
    (dir) => {
      chmodSync(join(dir, "refs"), 0o600);
    },
    true,
  ],
  ["HEAD is a ref outside refs/", (dir) => writeFileSync(join(dir, "HEAD"), "ref: other/main\n")],
  [
    "HEAD is missing while objects/ and refs/ exist",
    (dir) => {
      rmSync(join(dir, "HEAD"));
    },
  ],
];

const CASES = VARIANTS.map(([name, vary, needsUser]) => ({ name, vary, needsUser: needsUser ?? false }));

describe("a .git entry that is not fully accepted asks (MC7)", () => {
  afterEach(() => {
    for (const dir of ["outer/inner/.git", "clean/inner/.git"])
      try {
        chmodSync(join(root, dir, "objects"), 0o755);
        chmodSync(join(root, dir, "refs"), 0o755);
      } catch {
        // the folder was never created in this case
      }
  });

  it.each(CASES)("dirty outer, fake inner: $name", async ({ vary, needsUser }) => {
    if (needsUser && asRoot) return;
    repo(join(root, "outer"), DIRTY);
    const inner = join(root, "outer", "inner");
    mkdirSync(join(inner, "src"), { recursive: true });
    vary(gitDir(join(inner, ".git"), CLEAN));
    expect(await check(join(inner, "src"))).toBe(GIT_UNREADABLE);
  });

  it.each(CASES)("clean outer, dirty inner: $name", async ({ vary, needsUser }) => {
    if (needsUser && asRoot) return;
    repo(join(root, "clean"), CLEAN);
    const inner = join(root, "clean", "inner");
    mkdirSync(join(inner, "src"), { recursive: true });
    vary(gitDir(join(inner, ".git"), DIRTY));
    expect(await check(join(inner, "src"))).toBe(GIT_UNREADABLE);
  });

  it("asks for a bare-looking folder with only a HEAD file", async () => {
    repo(join(root, "outer"), CLEAN);
    const stray = join(root, "outer", "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "HEAD"), "whatever\n");
    expect(await check(stray)).toBe(GIT_UNREADABLE);
  });

  it("asks for a .git file that is not exactly gitdir: <path>", async () => {
    repo(join(root, "outer"), CLEAN);
    gitDir(join(root, "store"), DIRTY);
    for (const text of [
      `gitdir: ${join(root, "store")} extra\n`,
      `gitdir:${join(root, "store")}\n`,
      `GITDIR: ${join(root, "store")}\n`,
      `gitdir: ${join(root, "store")}\r\n`,
    ]) {
      mkdirSync(join(root, "outer", "w"), { recursive: true });
      writeFileSync(join(root, "outer", "w", ".git"), text);
      expect(await check(join(root, "outer", "w")), text).toBe(GIT_UNREADABLE);
    }
  });

  it("asks for a gitfile whose target fails the same check", async () => {
    const store = gitDir(join(root, "store"), DIRTY);
    rmSync(join(store, "refs"), { recursive: true });
    mkdirSync(join(root, "w"));
    writeFileSync(join(root, "w", ".git"), `gitdir: ${store}\n`);
    expect(await check(join(root, "w"))).toBe(GIT_UNREADABLE);
  });

  it("asks for a worktree whose commondir fails the same check", async () => {
    const main = repo(join(root, "main"));
    rmSync(join(main, ".git", "objects"), { recursive: true });
    const wt = join(main, ".git", "worktrees", "w");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "HEAD"), "ref: refs/heads/w\n");
    writeFileSync(join(wt, "commondir"), "../..\n");
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "work", ".git"), `gitdir: ${wt}\n`);
    expect(await check(join(root, "work"))).toBe(GIT_UNREADABLE);
  });
});

describe("a .git entry that is fully accepted is read", () => {
  it("accepts a lowercase 40 hex HEAD with a line break", async () => {
    const inner = join(root, "r");
    mkdirSync(inner);
    writeFileSync(join(gitDir(join(inner, ".git"), DIRTY), "HEAD"), `${HEX}\n`);
    expect(await check(inner)).toBe(GIT_RUNS_PROGRAM);
  });

  it("accepts a HEAD symlink to an existing refs/ file", async () => {
    const inner = join(root, "r");
    mkdirSync(inner);
    const dir = gitDir(join(inner, ".git"), DIRTY);
    mkdirSync(join(dir, "refs", "heads"));
    writeFileSync(join(dir, "refs", "heads", "main"), `${HEX}\n`);
    rmSync(join(dir, "HEAD"));
    symlinkSync("refs/heads/main", join(dir, "HEAD"));
    expect(await check(inner)).toBe(GIT_RUNS_PROGRAM);
  });
});
